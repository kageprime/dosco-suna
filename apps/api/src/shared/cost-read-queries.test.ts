import { describe, expect, test } from 'bun:test';
import { QueryPromise } from 'drizzle-orm/query-promise';
import { drainCostReadQueries, withCostReadGuard } from './cost-read-guard';

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class LazyQuery<T> extends QueryPromise<T> {
  executions = 0;
  constructor(private readonly run: () => Promise<T>) { super(); }
  execute(): Promise<T> { this.executions++; return this.run(); }
}

// Flush promise reactions without timers or a database.
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('cost read query draining', () => {
  test('preserves ordered heterogeneous results and executes lazy queries once', async () => {
    const query = new LazyQuery(async () => 7);
    expect(await drainCostReadQueries([query, Promise.resolve('ok')])).toEqual([7, 'ok']);
    expect(query.executions).toBe(1);
    expect(await drainCostReadQueries([])).toEqual([]);
  });

  for (const nested of [false, true]) {
    test(`holds the permit for original siblings after rejection (nested=${nested})`, async () => {
      const slow = deferred<number>();
      const fail = deferred<number>();
      const laterFail = deferred<number>();
      const original = new Error('original query failed');
      let active = 0;
      const sibling = new LazyQuery(async () => {
        active++;
        try { return await slow.promise; } finally { active--; }
      });
      const failed = new LazyQuery(() => fail.promise);
      const second = new LazyQuery(() => laterFail.promise);
      let nextStarted = false;
      let activeWhenNextStarted = -1;
      const report = withCostReadGuard<unknown>(() => nested
        ? drainCostReadQueries([Promise.resolve('rows'), drainCostReadQueries([failed, sibling, second])])
        : drainCostReadQueries([failed, sibling, second]));
      const outcome = report.then(() => undefined, (error: unknown) => error);
      const next = withCostReadGuard(async () => {
        nextStarted = true;
        activeWhenNextStarted = active;
        return 'next';
      });
      await flush();
      fail.reject(original);
      await flush();
      laterFail.reject(new Error('second query failed'));
      await flush();
      const startedBeforeDrain = nextStarted;
      const executionsBeforeDrain = sibling.executions;
      slow.resolve(42);
      expect(await outcome).toBe(original);
      expect(await next).toBe('next');
      expect(startedBeforeDrain).toBe(false);
      expect(executionsBeforeDrain).toBe(1);
      expect([failed.executions, sibling.executions, second.executions]).toEqual([1, 1, 1]);
      expect(activeWhenNextStarted).toBe(0);
      expect(await withCostReadGuard(async () => 'queue recovered')).toBe('queue recovered');
    });
  }
});
