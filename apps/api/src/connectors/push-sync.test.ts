import { describe, expect, test } from 'bun:test';
import { syncConfigAfterPush } from './push-sync';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('syncConfigAfterPush', () => {
  test('refreshes the mirror, then syncs once', async () => {
    const calls: string[] = [];
    await syncConfigAfterPush('p-once', {
      refresh: async () => void calls.push('refresh'),
      sync: async () => (calls.push('sync'), { synced: 1, errors: [] }),
    });
    expect(calls).toEqual(['refresh', 'sync']);
  });

  test('pushes during a running sync coalesce into exactly one more run', async () => {
    const gate = deferred();
    let syncs = 0;
    const deps = {
      refresh: async () => {},
      sync: async () => {
        syncs++;
        if (syncs === 1) await gate.promise;
        return { synced: 0, errors: [] };
      },
    };
    const first = syncConfigAfterPush('p-burst', deps);
    const second = syncConfigAfterPush('p-burst', deps);
    const third = syncConfigAfterPush('p-burst', deps);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(syncs).toBe(2);
  });

  test('a failed sync never rejects, and the next push runs again', async () => {
    let syncs = 0;
    const failing = {
      refresh: async () => {},
      sync: async () => {
        syncs++;
        throw new Error('git unreachable');
      },
    };
    await expect(syncConfigAfterPush('p-fail', failing)).resolves.toBeUndefined();
    await syncConfigAfterPush('p-fail', failing);
    expect(syncs).toBe(2);
  });

  test('projects do not wait on each other', async () => {
    const gate = deferred();
    let otherDone = false;
    const slow = syncConfigAfterPush('p-slow', {
      refresh: async () => {},
      sync: async () => (await gate.promise, { synced: 0, errors: [] }),
    });
    await syncConfigAfterPush('p-fast', {
      refresh: async () => {},
      sync: async () => ((otherDone = true), { synced: 0, errors: [] }),
    });
    expect(otherDone).toBe(true);
    gate.resolve();
    await slow;
  });
});
