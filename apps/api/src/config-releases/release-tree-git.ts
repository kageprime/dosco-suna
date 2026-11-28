/**
 * Git for `release-tree.ts`, which runs in the tree threads (`tree-jobs.ts`).
 *
 * A tree thread loads only `release-tree.ts`, this module and small pure
 * helpers: never `config.ts` or `projects/`, whose imports start the API. So
 * whoever starts it passes what it needs (`configureReleaseTreeGit`):
 * - `objects`: downloads into a project's partial store. Only the API process
 *   holds the project's credentials, so in a tree thread each call is a
 *   request to it;
 * - `run`: starts a child process (`git`, `gzip`). In a tree thread each call
 *   is a request too: the API process starts every child (`startProcess`), so
 *   it can kill the children of a thread it stops, and its own event loop
 *   reaps them. A child a thread started itself would outlive the thread, and
 *   stay a zombie of the API process once it ended;
 * - `scratchDir`: the folder scratch repositories are made in. A tree thread
 *   gets its own, which the API process removes when it stops the thread.
 */

import { spawn } from 'node:child_process';

export interface ReleaseTreeObjects {
  /**
   * Make `oids` present in the project store at `repo`, and return the bytes
   * received. A no-op for a repository that is not a project's partial store.
   * Over `maxBytes`: `ObjectFetchTooLargeError`, nothing kept. With
   * `overLimitKey`, a fetch of that key once over `maxBytes` is not tried again.
   */
  ensureObjects(repo: string, oids: readonly string[], options?: { maxBytes?: number; overLimitKey?: string }): Promise<number>;
  /** Make every tree of `revs` present. */
  ensureCommitTrees(repo: string, revs: readonly string[]): Promise<void>;
  /** Download the objects a failed git command in `repo` named in `stderr`. True when any arrived: the command is run again. */
  faultIn(repo: string, stderr: string): Promise<boolean>;
}

/** The programs a release build runs. */
const COMMANDS = new Set(['git', 'gzip']);

/** One child process: plain data, so a tree thread can send it to the API process. */
export interface ProcessSpec {
  command: 'git' | 'gzip';
  args: string[];
  cwd: string;
  /** Variables over the API process's child environment (`GIT_INDEX_FILE`). */
  env?: Record<string, string>;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  input?: Uint8Array;
  /** Stdout past this kills the child: `overOutput`. */
  maxOutputBytes: number;
  /** A child still running after this is killed: `timedOut`. */
  timeoutMs: number;
}

export interface ProcessResult {
  /** On an `ArrayBuffer` of its own, so it moves to a tree thread instead of being copied. Empty when `overOutput`. */
  stdout: Uint8Array;
  /** At most `MAX_STDERR_BYTES`. */
  stderr: string;
  /** Null when a signal ended it: a kill on timeout, on output, or on its thread's stop. */
  exitCode: number | null;
  /** The bytes it wrote to stdout, also past `maxOutputBytes`. */
  stdoutBytes: number;
  overOutput: boolean;
  timedOut: boolean;
}

export type RunProcess = (spec: ProcessSpec) => Promise<ProcessResult>;

export interface StartedProcess {
  result: Promise<ProcessResult>;
  /** SIGKILL to its whole process group: also what it started (`git` runs `gzip`, a hook, a shell alias). */
  kill(): void;
}

/** The stderr a child keeps: enough for an error message and the object IDs of a fault-in. */
const MAX_STDERR_BYTES = 64 * 1024;

/** The environment of a child: no prompt, and no lazy fetch (`projects/git/object-store.ts`). */
export function childEnv(base: Record<string, string | undefined>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra, GIT_NO_LAZY_FETCH: '1' };
}

/**
 * Start `spec` as a child of this process, in a process group of its own, so
 * `kill` reaches what it started too. The child is killed past its time or
 * its output bound. `result` settles when it ended and its pipes closed.
 */
export function startProcess(spec: ProcessSpec, baseEnv: Record<string, string | undefined>): StartedProcess {
  if (!COMMANDS.has(spec.command)) {
    return { result: Promise.reject(new Error(`not a release-build command: ${spec.command}`)), kill: () => undefined };
  }
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: childEnv(baseEnv, spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let closed = false;
  let killed = false;
  const kill = () => {
    // After `close` the group is gone, and its ID can belong to another process.
    if (closed || killed || child.pid === undefined) return;
    killed = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overOutput = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, spec.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (overOutput) return;
    if (stdoutBytes > spec.maxOutputBytes) {
      overOutput = true;
      stdout.length = 0;
      kill();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return;
    const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
    stderr.push(kept);
    stderrBytes += kept.length;
  });
  child.stdin.on('error', () => undefined);
  if (spec.input) child.stdin.end(spec.input);
  else child.stdin.end();
  const result = new Promise<ProcessResult>((resolveResult, reject) => {
    child.once('error', (error) => {
      closed = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code: number | null) => {
      closed = true;
      clearTimeout(timer);
      const bytes = new Uint8Array(overOutput ? 0 : stdoutBytes);
      let at = 0;
      for (const chunk of stdout) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      resolveResult({
        stdout: bytes,
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
        stdoutBytes,
        overOutput,
        timedOut,
      });
    });
  });
  return { result, kill };
}

export interface ReleaseTreeGitConfig {
  objects: ReleaseTreeObjects;
  run: RunProcess;
  scratchDir: string;
}

let configured: ReleaseTreeGitConfig | null = null;

export function configureReleaseTreeGit(next: ReleaseTreeGitConfig): void {
  configured = next;
}

function current(): ReleaseTreeGitConfig {
  if (!configured) throw new Error('release-tree git is not configured');
  return configured;
}

export function treeObjects(): ReleaseTreeObjects {
  return current().objects;
}

export function scratchDir(): string {
  return current().scratchDir;
}

/** Run a child process (`ProcessSpec`). */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return current().run(spec);
}

/** What one git call returns at most on stdout, as `runGitCapture` in `projects/git/mirror.ts`. */
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
/** Times one command is run again after a download of the objects it named. */
const MAX_FAULT_ROUNDS = 2;
/** The stderr a fault-in request carries at most. */
const MAX_FAULT_STDERR_CHARS = 64 * 1024;
/** An object ID in git's stderr: only such a failure can be a missing object. */
const OBJECT_ID = /\b[0-9a-f]{40}\b/;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `git <args>` in `cwd`. Never throws on a non-zero exit. A command that
 * failed on objects a partial store lacks runs again once they are
 * downloaded, as `runGitCapture` does in the API process.
 */
export async function runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
  for (let round = 0; ; round += 1) {
    const result = await execGit(args, cwd, env);
    // A failure that names no object (a path that does not exist) is an answer, not a missing object.
    if (result.exitCode === 0 || round >= MAX_FAULT_ROUNDS || !OBJECT_ID.test(result.stderr)) return result;
    if (!(await treeObjects().faultIn(cwd, result.stderr.slice(0, MAX_FAULT_STDERR_CHARS)))) return result;
  }
}

async function execGit(args: string[], cwd: string, env?: Record<string, string>): Promise<GitResult> {
  const result = await runProcess({ command: 'git', args, cwd, env, maxOutputBytes: MAX_GIT_OUTPUT_BYTES, timeoutMs: GIT_TIMEOUT_MS });
  // Past a bound the output is cut short: a failure, never a short answer.
  const cut = result.overOutput ? `output over ${MAX_GIT_OUTPUT_BYTES} bytes` : result.timedOut ? `no answer in ${GIT_TIMEOUT_MS} ms` : '';
  return {
    stdout: Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength).toString('utf8'),
    stderr: cut ? `${result.stderr}\ngit ${args[0]}: ${cut}` : result.stderr,
    exitCode: cut ? (result.exitCode || 1) : (result.exitCode ?? 1),
  };
}
