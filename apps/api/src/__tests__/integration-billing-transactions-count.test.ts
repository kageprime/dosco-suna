//
// Real-PostgreSQL tests for the bounded pagination count on the billing
// transaction and usage reads (KRTX-3175).
//
// Before: `SELECT count(*) WHERE account_id = $1` read the account's whole
// ledger slice on every page view, and for a heavy account the planner turned
// it into a parallel seq scan of the whole table. Those multi-second counts,
// under concurrent load, rode past the API's 25s request deadline and returned
// 503s on GET /v1/billing/transactions. The count is now bounded at
// COUNT_SCAN_CAP: exact below the cap, the cap at or above it.
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const { db } = await import('../shared/db');
const { COUNT_SCAN_CAP, getTransactions } = await import('../billing/repositories/transactions');

const HEAVY_ACCOUNT = '00000000-0000-4000-8000-00000000d001';
const LIGHT_ACCOUNT = '00000000-0000-4000-8000-00000000d002';

async function seedLedgerRows(accountId: string, rows: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO kortix.credit_ledger
      (account_id, type, description, created_at, amount, balance_after, amount_precise, balance_after_precise)
    SELECT ${accountId}::uuid, 'compute_debit', 'synthetic', now() - (g || ' seconds')::interval,
           -0.0001, 100.0, -0.0001, 100.0
    FROM generate_series(0, ${rows - 1}) g
  `);
}

beforeAll(async () => {
  // One row over the cap: without the bound, total reports COUNT_SCAN_CAP + 1
  // and the heavy test fails — the unbounded count scanned all of them.
  await seedLedgerRows(HEAVY_ACCOUNT, COUNT_SCAN_CAP + 1);
  await seedLedgerRows(LIGHT_ACCOUNT, 120);
});

describe('getTransactions pagination count', () => {
  test('a heavy account total is bounded at the cap and the page still reads', async () => {
    const { rows, total } = await getTransactions(HEAVY_ACCOUNT, 50, 0);
    expect(rows).toHaveLength(50);
    expect(total).toBe(COUNT_SCAN_CAP);
  });

  test('a heavy account pages past its first page under the same bound', async () => {
    const second = await getTransactions(HEAVY_ACCOUNT, 50, 50);
    expect(second.rows).toHaveLength(50);
    expect(second.total).toBe(COUNT_SCAN_CAP);
  });

  test('a light account total stays exact', async () => {
    const { rows, total } = await getTransactions(LIGHT_ACCOUNT, 50, 0);
    expect(rows).toHaveLength(50);
    expect(total).toBe(120);
  });

  test('a type filter narrows the bounded count too', async () => {
    const { total } = await getTransactions(LIGHT_ACCOUNT, 50, 0, 'no_such_type');
    expect(total).toBe(0);
  });
});
