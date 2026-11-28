/**
 * A tree thread for `tree-jobs.test.ts`: it speaks `tree-protocol.ts` and runs
 * jobs built to test the thread limits, not release trees.
 */
import { ConfigArchiveTooLargeError } from '../../release-tree';
import { deserializeError, serializeError, type FromThread, type ToThread } from '../../tree-protocol';

declare const self: Worker;

const pending = new Map<number, (message: Extract<ToThread, { type: 'response' }>) => void>();
let lastRequest = 0;

function post(message: FromThread, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

async function run(jobId: number, op: string, args: { ms?: number; text?: string }): Promise<unknown> {
  switch (op) {
    case 'spin':
      for (;;) {
        // A job that never ends and never gives its thread back.
      }
    case 'sleep':
      await Bun.sleep(args.ms ?? 0);
      return args.ms;
    case 'request': {
      const id = (lastRequest += 1);
      const answer = await new Promise<Extract<ToThread, { type: 'response' }>>((resolve) => {
        pending.set(id, resolve);
        post({ type: 'request', jobId, id, method: 'ensureObjects', args: ['repo', [args.text ?? ''], {}] });
      });
      if (!answer.ok) throw deserializeError(answer.error, id);
      return answer.value;
    }
    case 'hang': {
      // A child process that outlives its job: git runs a shell alias, which runs `sleep`.
      const id = (lastRequest += 1);
      const answer = await new Promise<Extract<ToThread, { type: 'response' }>>((resolve) => {
        pending.set(id, resolve);
        const spec = { command: 'git', args: ['-c', `alias.hang=!sleep ${args.text}; :`, 'hang'], cwd: '/', maxOutputBytes: 1024, timeoutMs: 60_000 };
        post({ type: 'request', jobId, id, method: 'run', args: [spec] });
      });
      if (!answer.ok) throw deserializeError(answer.error, id);
      return answer.value;
    }
    case 'tooLarge':
      throw new ConfigArchiveTooLargeError(5, 9);
    case 'crash':
      setTimeout(() => {
        throw new Error('thread crashed');
      }, 0);
      return new Promise(() => undefined);
    case 'archive':
      return new Uint8Array([1, 2, 3]);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

self.onmessage = async (event: MessageEvent<ToThread>) => {
  const message = event.data;
  if (message.type === 'init') return;
  if (message.type === 'response') {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  try {
    const value = await run(message.id, message.op, message.args as { ms?: number; text?: string });
    post({ type: 'result', id: message.id, ok: true, value });
  } catch (error) {
    post({ type: 'result', id: message.id, ok: false, error: serializeError(error) });
  }
};
