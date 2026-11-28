/**
 * A tree thread: runs the release-tree jobs `tree-jobs.ts` sends it, one at a
 * time. All its work on repository content (listings, parses, archives) runs
 * here, never on the API event loop, and the API process stops the thread
 * when a job runs too long.
 *
 * It loads only `release-tree.ts` and its small helpers. A download into a
 * project's partial store needs the project's credentials, which only the API
 * process holds: the thread asks for it (`request`), and the API process
 * answers. The thread starts no child process either: it asks the API
 * process to run each one (`run`), which kills them when it stops the thread.
 */

import { mkdir } from 'node:fs/promises';
import { configureReleaseTreeGit, type ProcessResult, type ProcessSpec, type ReleaseTreeObjects } from './release-tree-git';
import {
  deserializeError,
  serializeError,
  treeOps,
  type FromThread,
  type ToThread,
  type TreeOp,
  type TreeRequestMethod,
} from './tree-protocol';

declare const self: Worker;

let currentJob = 0;
let lastRequest = 0;
// replica-local: this thread's requests to the API process that wait for an answer.
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function post(message: FromThread, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function request<T>(method: TreeRequestMethod, args: unknown[], transfer: Transferable[] = []): Promise<T> {
  const id = (lastRequest += 1);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    post({ type: 'request', jobId: currentJob, id, method, args }, transfer);
  });
}

const objects: ReleaseTreeObjects = {
  ensureObjects: (repo, oids, options) => request('ensureObjects', [repo, oids, options]),
  ensureCommitTrees: (repo, revs) => request('ensureCommitTrees', [repo, revs]),
  faultIn: (repo, stderr) => request('faultIn', [repo, stderr]),
};

/** A byte array on an `ArrayBuffer` of its own: it moves between the threads instead of being copied. */
function own(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
}

function run(spec: ProcessSpec): Promise<ProcessResult> {
  if (!spec.input) return request('run', [spec]);
  const input = own(spec.input);
  return request('run', [{ ...spec, input }], [input.buffer as ArrayBuffer]);
}

/** The byte arrays of a result, each on an `ArrayBuffer` of its own, so they move to the API process instead of being copied. */
function movable(value: unknown): { value: unknown; transfer: Transferable[] } {
  if (value instanceof Uint8Array) {
    const bytes = own(value);
    return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
  }
  if (value && typeof value === 'object' && 'archive' in value && value.archive instanceof Uint8Array) {
    const bytes = own(value.archive);
    return { value: { ...value, archive: bytes }, transfer: [bytes.buffer as ArrayBuffer] };
  }
  return { value, transfer: [] };
}

let ready: Promise<void> = Promise.reject(new Error('tree thread received no init'));
ready.catch(() => undefined);

async function runJob(id: number, op: TreeOp, args: unknown): Promise<void> {
  currentJob = id;
  try {
    await ready;
    const run = treeOps[op] as (input: unknown) => Promise<unknown>;
    const { value, transfer } = movable(await run(args));
    post({ type: 'result', id, ok: true, value }, transfer);
  } catch (error) {
    post({ type: 'result', id, ok: false, error: serializeError(error) });
  }
}

self.onmessage = (event: MessageEvent<ToThread>) => {
  const message = event.data;
  if (message.type === 'init') {
    ready = mkdir(message.scratchDir, { recursive: true }).then(() => {
      configureReleaseTreeGit({ objects, run, scratchDir: message.scratchDir });
    });
    return;
  }
  if (message.type === 'job') {
    void runJob(message.id, message.op, message.args);
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.ok) waiting.resolve(message.value);
  else waiting.reject(deserializeError(message.error, message.id));
};
