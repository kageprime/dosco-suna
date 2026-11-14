/**
 * postgres.js 3.4.9 resolves a SPARSE RowList for the first statement after a
 * mid-result error on the same pooled connection (KRTX-4817 — prod TypeError
 * `undefined is not an object (evaluating 'row.expected')` at
 * apps/api/src/workspaces/store.ts:livePairs, released kortix-api@0.15.9).
 *
 * The connection-level row counter (`rows` in postgres.js src/connection.js)
 * is reset only by CommandComplete and PortalSuspended. A statement that
 * streams DataRows and then errors — in prod, statement_timeout → 57014, a
 * statement class this database already sees — never sends CommandComplete,
 * so the counter stays stale. ReadyForQuery resets `result` but not `rows`,
 * so the NEXT statement on that connection writes its rows at index k.. and
 * the resolved RowList keeps holes. `for..of` then reads `undefined` (the
 * prod TypeError) and `.map()`/`.flatMap()` silently skip the holes (silent
 * row loss).
 *
 * The repo's `patches/postgres@3.4.9.patch` resets `rows = 0` alongside
 * `result = new Result()` in ReadyForQuery. This file needs only a live
 * PostgreSQL — no tables, no migrations.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suite = databaseUrl ? describe : describe.skip;

// Wide margins so the erroring statement always streams rows before the
// timeout fires: one row every ~100 ms, timeout at 500 ms → several DataRows,
// then 57014. On a slow runner the timeout still lands after row 1.
const STREAM_TIMEOUT = '500ms';
const SLEEP_PER_ROW = 0.1;
const STREAM_ROWS = 8;
const VICTIM_ROWS = 3;

suite('postgres.js resolves a dense RowList after a mid-result error on the connection', () => {
  // max 1: every statement below lands on the SAME pooled connection — the
  // prod shape, where the pool reuses a connection that just errored.
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  afterAll(() => client.end({ timeout: 5 }));

  test('the statement after a statement_timeout mid-result has no holes', async () => {
    // SET is a utility statement: it takes no bind parameters, so the
    // constant timeout is interpolated directly.
    await client.unsafe(`SET statement_timeout = '${STREAM_TIMEOUT}'`);

    let errorRowsLost = false;
    try {
      await client`SELECT g, pg_sleep(${SLEEP_PER_ROW}) FROM generate_series(1, ${STREAM_ROWS}) AS g`;
      // No rejection: the timeout never fired, so this run proves nothing
      // about the fix. Fail loudly instead of passing vacuously.
      errorRowsLost = true;
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('57014');
    }
    expect(errorRowsLost).toBeFalse();

    // The victim: the FIRST statement on this connection after the error —
    // the exact position of `livePairs`' query in prod.
    const rows = await client`SELECT g AS expected, g * 2 AS stored FROM generate_series(1, ${VICTIM_ROWS}) AS g`;

    const holes: number[] = [];
    for (let i = 0; i < rows.length; i++) if (!(i in rows)) holes.push(i);
    expect(holes).toEqual([]);
    expect(rows.length).toBe(VICTIM_ROWS);

    // The exact prod expression: iterate and read both jsonb columns.
    const seen: number[] = [];
    for (const row of rows) seen.push(row.expected);
    expect(seen).toEqual([1, 2, 3]);

    // The silent-loss shape: Array.prototype.map skips holes. After the fix
    // it must see every row.
    expect(rows.map((row) => row.expected)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.stored)).toEqual([2, 4, 6]);
  });
});
