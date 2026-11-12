/**
 * The scale reconcile survives a 40P01 deadlock victim by re-running whole
 * (release run 42716922285, the db-suites lane's red). The suite's own real
 * PostgreSQL serves both attempts, and the first attempt's reads carry a
 * synthetic 40P01 — so a passing run can only be the retry's second pass:
 * the reconcile re-reads and answers `skipped: no_release` on the app row
 * that does not exist in a fresh suite database.
 */
import { describe, expect, mock, test } from 'bun:test';

process.env.KORTIX_APPS_WORKER_ENABLED = 'false';

const realDb = await import('../shared/db');

/** The first attempt's reads throw the victim; the retry gets the real pool. */
let poisoned = 0;
const db = new Proxy(realDb.db, {
  get(target, prop) {
    const value = Reflect.get(target, prop);
    if (poisoned > 0 && (prop === 'select' || prop === 'insert' || prop === 'update' || prop === 'delete')) {
      poisoned -= 1;
      throw Object.assign(new Error('deadlock detected'), { name: 'PostgresError', code: '40P01' });
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

mock.module('../shared/db', () => ({ ...realDb, db }));

const machines = await import('./machines');

const NO_APP_ID = '00000000-0000-4000-a000-00000000f104';

describe('machines deadlock retry — real PostgreSQL', () => {
  test('a 40P01 victim re-runs whole: the retry re-reads and lands on no_release', async () => {
    poisoned = 1;
    const result = await machines.reconcileAppMachines(NO_APP_ID);
    expect(poisoned).toBe(0);
    expect(result).toEqual({ created: 0, destroyed: 0, skipped: 'no_release' });
  });
});
