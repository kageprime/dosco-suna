/**
 * The tree threads: where a config release's tree is read, listed, parsed and
 * archived (`tree-thread.ts`). The API event loop only sends a job, starts the
 * child processes the job asks for, and receives its result, so no repository
 * tree can stall the API, whatever it holds. (The release's governance compile,
 * `kortix.yaml` and its prompt files, runs in the API process with a size
 * bound: `builder.ts`.)
 *
 * - `threads` threads per API process run one job each.
 * - Jobs are counted per project (here a workspace is one project and one
 *   account). One job per project runs at a time, and a free thread goes to
 *   the waiting project served least recently: a project that is not building
 *   waits behind at most one job of each project that is.
 * - A job may run `jobMillis` of its own time: the time its thread waits for
 *   a download the API process runs for it does not count, the download has
 *   its own bounds. Past that, or past `wallMillis` in all, the thread is
 *   stopped and replaced: its child processes are killed with their process
 *   groups, and its scratch folder removed. The job fails with
 *   `TreeJobTimeoutError`, and the same job of that project fails at once for
 *   `timeoutMemoMillis`.
 * - At most `maxWaitingPerProject` jobs of one project, and `maxWaiting` in
 *   all, wait for a thread, each for at most `maxWaitMillis`. Past any of
 *   them: `TreeJobBusyError`. Nothing is cached for it: the caller asks again.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProcess, type ProcessSpec, type ReleaseTreeObjects, type StartedProcess } from './release-tree-git';
import {
  asBuffer,
  deserializeError,
  serializeError,
  type FromThread,
  type ToThread,
  type TreeOp,
  type TreeOpArgs,
  type TreeOpResult,
} from './tree-protocol';

/** A job could not start: too many jobs of its project, or in all, wait, or it waited too long. */
export class TreeJobBusyError extends Error {
  constructor(readonly projectId: string) {
    super('another release of this project is being built; it is tried again at the next convergence');
    this.name = 'TreeJobBusyError';
  }
}

/** A job ran past its time, or the same job of this project did so recently. */
export class TreeJobTimeoutError extends Error {
  constructor(readonly projectId: string) {
    super('building the release took too long; it is tried again in a few minutes');
    this.name = 'TreeJobTimeoutError';
  }
}

export interface TreeJobsOptions {
  /** Answers the downloads a thread asks for, with the project's credentials. */
  objects: ReleaseTreeObjects;
  /** The variables every child process of a thread starts from. */
  env: Record<string, string | undefined>;
  /** Tests: another thread module that speaks `tree-protocol.ts`. */
  entry?: URL;
  threads?: number;
  jobMillis?: number;
  wallMillis?: number;
  maxWaitMillis?: number;
  maxWaitingPerProject?: number;
  maxWaiting?: number;
  timeoutMemoMillis?: number;
}

const DEFAULTS = {
  threads: 2,
  jobMillis: 60_000,
  wallMillis: 300_000,
  maxWaitMillis: 30_000,
  maxWaitingPerProject: 8,
  maxWaiting: 64,
  timeoutMemoMillis: 600_000,
};
/** Projects, and jobs per project, the timeout memo holds at most. */
const MAX_MEMO_PROJECTS = 1_000;
const MAX_MEMO_JOBS_PER_PROJECT = 100;
/** Projects whose last service the fair share remembers. A forgotten one counts as never served. */
const MAX_SERVED_PROJECTS = 1_000;
/** A job's identity reads at most this many entries of a list and characters of a string. */
const IDENTITY_LIST_ENTRIES = 16;
const IDENTITY_STRING_CHARS = 512;

/**
 * What identifies a job, at a cost that does not grow with the repository: a
 * string cut at `IDENTITY_STRING_CHARS` (with its length), a list by its
 * length and up to `IDENTITY_LIST_ENTRIES` entries spread over it plus its
 * last. A job's arguments can hold a whole tree listing.
 */
function identity(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > IDENTITY_STRING_CHARS ? `${value.slice(0, IDENTITY_STRING_CHARS)}\0${value.length}` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '\0deep';
  if (Array.isArray(value)) {
    const step = Math.max(1, Math.ceil(value.length / IDENTITY_LIST_ENTRIES));
    const picked: unknown[] = [];
    for (let at = 0; at < value.length; at += step) picked.push(identity(value[at], depth + 1));
    if (value.length > 0) picked.push(identity(value[value.length - 1], depth + 1));
    return { length: value.length, picked };
  }
  const entries = Object.entries(value).slice(0, IDENTITY_LIST_ENTRIES);
  return Object.fromEntries(entries.map(([name, field]) => [name, identity(field, depth + 1)]));
}

interface Job {
  projectId: string;
  op: TreeOp;
  args: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

interface RunningJob extends Job {
  id: number;
  /** Requests the thread waits on: its clock stops while any is open. */
  open: number;
  workLeft: number;
  workSince: number;
  workTimer?: ReturnType<typeof setTimeout>;
  wallTimer: ReturnType<typeof setTimeout>;
  /** The errors of this job's requests, by request ID: a job that fails on one fails with that very error. */
  requestErrors: Map<number, unknown>;
}

/** Bun's `Worker`: `ref`/`unref` decide whether it keeps the process alive. */
type Thread = Worker & { ref(): void; unref(): void };

interface Slot {
  thread: Thread;
  scratchDir: string;
  job: RunningJob | null;
  stopped: boolean;
  /** The child processes started for this thread that have not ended. */
  children: Set<StartedProcess>;
}

/**
 * A thread's scratch folder: `<tmp>/kortix-tree-thread-<pid>-<token>-<uuid>`.
 * `token` is drawn once per process, so a later process with the same ID (a
 * restarted container) can tell the folder is not its own.
 */
const SCRATCH_PREFIX = 'kortix-tree-thread-';
const PROCESS_TOKEN = randomUUID().slice(0, 8);
let sweptScratch = false;

/** Is `pid` a live process? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove the scratch folders that a process which ended left behind (a crash, a kill). Runs once per process. */
async function sweepScratch(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      if (!name.startsWith(SCRATCH_PREFIX)) return;
      const [pidText, token] = name.slice(SCRATCH_PREFIX.length).split('-');
      const pid = Number(pidText);
      if (!pid || token === PROCESS_TOKEN || (pid !== process.pid && alive(pid))) return;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

/** The bytes of a result (the result itself, or its `archive`), as `Buffer`s again. */
function revive(value: unknown): unknown {
  if (value instanceof Uint8Array) return asBuffer(value);
  if (value && typeof value === 'object' && 'archive' in value && value.archive instanceof Uint8Array) {
    return { ...value, archive: asBuffer(value.archive) };
  }
  return value;
}

export class TreeJobs {
  private readonly options: Required<Omit<TreeJobsOptions, 'entry'>> & { entry: URL };
  private readonly slots: Slot[] = [];
  private readonly waiting: Job[] = [];
  private readonly runningProjects = new Set<string>();
  /** When each project last got a thread, as a sequence number: the fair share. */
  private readonly served = new Map<string, number>();
  private lastServed = 0;
  /** Per project: the digest of each job that ran past its time, and when that stops counting. */
  private readonly timedOut = new Map<string, Map<string, number>>();
  /** The cleanups of stopped threads still running: their children end, then their folder goes. */
  private readonly cleanups = new Set<Promise<void>>();
  private lastJob = 0;

  constructor(options: TreeJobsOptions) {
    this.options = { ...DEFAULTS, entry: new URL('./tree-thread.ts', import.meta.url), ...options };
  }

  /** Run `op` for `projectId` in a tree thread. */
  run<K extends TreeOp>(projectId: string, op: K, args: TreeOpArgs<K>): Promise<TreeOpResult<K>> {
    if (this.timedOutRecently(projectId, op, args)) return Promise.reject(new TreeJobTimeoutError(projectId));
    const ofProject = this.waiting.filter((job) => job.projectId === projectId).length;
    if (ofProject >= this.options.maxWaitingPerProject || this.waiting.length >= this.options.maxWaiting) {
      return Promise.reject(new TreeJobBusyError(projectId));
    }
    return new Promise<TreeOpResult<K>>((resolve, reject) => {
      const job: Job = { projectId, op, args, resolve: resolve as (value: unknown) => void, reject };
      job.waitTimer = setTimeout(() => {
        const at = this.waiting.indexOf(job);
        if (at < 0) return;
        this.waiting.splice(at, 1);
        reject(new TreeJobBusyError(projectId));
      }, this.options.maxWaitMillis);
      this.waiting.push(job);
      this.pump();
    });
  }

  /** Stop every thread, and wait until their children ended and their folders are gone. Tests only: a job still running fails. */
  async close(): Promise<void> {
    for (const slot of [...this.slots]) this.stop(slot, new Error('tree threads closed'));
    await Promise.all([...this.cleanups]);
  }

  /** The waiting job to run next: of a project with no running job, the one served least recently; first come first within it. */
  private next(): number {
    let best = -1;
    let bestServed = Infinity;
    for (let at = 0; at < this.waiting.length; at += 1) {
      const { projectId } = this.waiting[at]!;
      if (this.runningProjects.has(projectId)) continue;
      const served = this.served.get(projectId) ?? -1;
      if (served < bestServed) {
        best = at;
        bestServed = served;
      }
    }
    return best;
  }

  private pump(): void {
    for (;;) {
      const at = this.next();
      if (at < 0) return;
      let slot = this.slots.find((candidate) => !candidate.job) ?? null;
      if (!slot && this.slots.length < this.options.threads) {
        try {
          slot = this.startThread();
        } catch (error) {
          // No thread can start (a broken install): the job fails now, not at its wait bound.
          const [job] = this.waiting.splice(at, 1);
          clearTimeout(job!.waitTimer);
          job!.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
      }
      if (!slot) return;
      const [job] = this.waiting.splice(at, 1);
      this.start(slot, job!);
    }
  }

  private startThread(): Slot {
    if (!sweptScratch) {
      sweptScratch = true;
      this.track(sweepScratch(tmpdir()));
    }
    const scratchDir = join(tmpdir(), `${SCRATCH_PREFIX}${process.pid}-${PROCESS_TOKEN}-${randomUUID()}`);
    const thread = new Worker(this.options.entry) as Thread;
    const slot: Slot = { thread, scratchDir, job: null, stopped: false, children: new Set() };
    thread.unref();
    thread.addEventListener('message', (event: MessageEvent<FromThread>) => this.receive(slot, event.data));
    thread.addEventListener('error', (event) => {
      event.preventDefault();
      this.stop(slot, new Error(`tree thread failed: ${(event as ErrorEvent).message}`));
    });
    thread.addEventListener('close', () => this.stop(slot, new Error('tree thread exited')));
    this.post(slot, { type: 'init', scratchDir });
    this.slots.push(slot);
    return slot;
  }

  private post(slot: Slot, message: ToThread, transfer: Transferable[] = []): void {
    slot.thread.postMessage(message, transfer);
  }

  private track(cleanup: Promise<void>): void {
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
  }

  private start(slot: Slot, job: Job): void {
    clearTimeout(job.waitTimer);
    const running: RunningJob = {
      ...job,
      id: (this.lastJob += 1),
      open: 0,
      workLeft: this.options.jobMillis,
      workSince: 0,
      wallTimer: setTimeout(() => this.stop(slot, this.noteTimeout(running)), this.options.wallMillis),
      requestErrors: new Map(),
    };
    slot.job = running;
    this.runningProjects.add(job.projectId);
    this.served.delete(job.projectId);
    this.served.set(job.projectId, (this.lastServed += 1));
    if (this.served.size > MAX_SERVED_PROJECTS) this.served.delete(this.served.keys().next().value!);
    slot.thread.ref();
    this.resumeClock(slot, running);
    this.post(slot, { type: 'job', id: running.id, op: job.op, args: job.args });
  }

  private resumeClock(slot: Slot, job: RunningJob): void {
    job.workSince = performance.now();
    job.workTimer = setTimeout(() => this.stop(slot, this.noteTimeout(job)), Math.max(0, job.workLeft));
  }

  private pauseClock(job: RunningJob): void {
    clearTimeout(job.workTimer);
    job.workLeft -= performance.now() - job.workSince;
  }

  private receive(slot: Slot, message: FromThread): void {
    const job = slot.job;
    if (message.type === 'request') {
      if (!job || job.id !== message.jobId) return;
      void this.answer(slot, job, message.id, message.method, message.args);
      return;
    }
    if (!job || job.id !== message.id) return;
    this.finish(slot, job);
    if (message.ok) {
      job.resolve(revive(message.value));
      return;
    }
    const original = message.error.requestId === undefined ? undefined : job.requestErrors.get(message.error.requestId);
    job.reject(original instanceof Error ? original : deserializeError(message.error));
  }

  /**
   * Answer a request of the thread: a download, during which its clock stops,
   * or a child process (`run`), whose time counts as the job's own.
   */
  private async answer(slot: Slot, job: RunningJob, id: number, method: keyof ReleaseTreeObjects | 'run', args: unknown[]): Promise<void> {
    const download = method !== 'run';
    if (download && job.open++ === 0) this.pauseClock(job);
    let reply: ToThread;
    let transfer: Transferable[] = [];
    try {
      if (method === 'run') {
        const result = await this.runChild(slot, args[0] as ProcessSpec);
        reply = { type: 'response', id, ok: true, value: result };
        transfer = [result.stdout.buffer as ArrayBuffer];
      } else {
        const handler = this.options.objects[method] as (...input: unknown[]) => Promise<unknown>;
        reply = { type: 'response', id, ok: true, value: await handler(...args) };
      }
    } catch (error) {
      job.requestErrors.set(id, error);
      reply = { type: 'response', id, ok: false, error: serializeError(error) };
    }
    if (slot.job !== job) return;
    if (download && --job.open === 0) this.resumeClock(slot, job);
    this.post(slot, reply, transfer);
  }

  /** Start a child process for `slot`'s thread. It is the API process's child: its event loop reaps it, and `stop` kills it. */
  private async runChild(slot: Slot, spec: ProcessSpec) {
    if (slot.stopped) throw new Error('tree thread stopped');
    const child = startProcess(spec, this.options.env);
    slot.children.add(child);
    try {
      return await child.result;
    } finally {
      slot.children.delete(child);
    }
  }

  private finish(slot: Slot, job: RunningJob): void {
    clearTimeout(job.workTimer);
    clearTimeout(job.wallTimer);
    slot.job = null;
    this.runningProjects.delete(job.projectId);
    slot.thread.unref();
    this.pump();
  }

  /**
   * Stop `slot`'s thread; its job fails with `error`. Its child processes are
   * killed with their process groups, and its scratch folder is removed once
   * they ended: none writes into it after.
   */
  private stop(slot: Slot, error: Error): void {
    if (slot.stopped) return;
    slot.stopped = true;
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    slot.thread.terminate();
    const children = [...slot.children];
    for (const child of children) child.kill();
    this.track(
      Promise.allSettled(children.map((child) => child.result))
        .then(() => rm(slot.scratchDir, { recursive: true, force: true }))
        .catch(() => undefined),
    );
    const job = slot.job;
    if (job) {
      this.finish(slot, job);
      job.reject(error);
    } else {
      this.pump();
    }
  }

  private digest(op: TreeOp, args: unknown): string {
    return createHash('sha256').update(op).update('\0').update(JSON.stringify(identity(args))).digest('hex');
  }

  private noteTimeout(job: RunningJob): TreeJobTimeoutError {
    let jobs = this.timedOut.get(job.projectId);
    if (!jobs) {
      jobs = new Map();
      this.timedOut.set(job.projectId, jobs);
      if (this.timedOut.size > MAX_MEMO_PROJECTS) this.timedOut.delete(this.timedOut.keys().next().value!);
    }
    jobs.set(this.digest(job.op, job.args), Date.now() + this.options.timeoutMemoMillis);
    if (jobs.size > MAX_MEMO_JOBS_PER_PROJECT) jobs.delete(jobs.keys().next().value!);
    return new TreeJobTimeoutError(job.projectId);
  }

  /** Did this very job of this project run past its time lately? Only a project with such a job pays for the digest. */
  private timedOutRecently(projectId: string, op: TreeOp, args: unknown): boolean {
    const jobs = this.timedOut.get(projectId);
    if (!jobs) return false;
    const key = this.digest(op, args);
    const until = jobs.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    jobs.delete(key);
    if (jobs.size === 0) this.timedOut.delete(projectId);
    return false;
  }
}
