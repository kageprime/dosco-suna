/**
 * DB suite: the account+window LLM scans of the cost explorer
 * (`GET /v1/usage/cost-summary`, `GET /v1/usage/cost-by-project`) must scan
 * `idx_gateway_logs_account_time_covering` INDEX-ONLY — never the wide heap
 * rows (each carries the request/response jsonb payloads) — and a mass UPDATE
 * over the table degrades those scans to heap fetches until VACUUM restores
 * the visibility map.
 *
 * Two incidents set these contracts:
 *  - KRTX-4022 (2026-11-04): a column added to a gateway aggregate without
 *    the covering index turned its index-only scan into heap fetches of every
 *    wide row — 5-24s queries and 503s at the 25s request deadline.
 *  - KRTX-4638 (2026-11-10): the `gateway_logs_llm_value_backfill` migration
 *    mass-UPDATEd ~70% of the 4.1M-row table, clearing every touched page's
 *    all-visible bit; the account-led cost scans heap-fetched again
 *    (db;dur≈25s across n=8 statements) and the route 503'd until a vacuum.
 *
 * Seed shape: 199 sibling accounts plus the pinned one, the pinned account's
 * rows interleaved among theirs. A one-account table is perfectly heap-correlated (every heap
 * fetch reads the same handful of pages in index order) and the planner then
 * prices heap fetches as nearly free — the toy table prefers a heap-fetching
 * index scan exactly as the planner prefers nothing on prod. Scattered rows
 * price a heap-fetching scan at one random fetch per row, so the index-only
 * path wins by an order of magnitude, and a column drifting out of the
 * INCLUDE list (which makes index-only illegal) fails the first test.
 *
 * Why the GUCs are only seqscan+bitmapscan: `enable_indexscan = off` also
 * demotes Index Only Scans (verified on PG 17.6), so the trio
 * gateway-series.integration.test.ts uses flips to a demoted seq scan once
 * real statistics exist. With index scans enabled and scattered rows, the
 * index-only path wins on cost, deterministically, whether or not the table
 * was ANALYZEd.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projects } from '@kortix/db';
import { eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';

import { costByProjectLlmQuery, costLlmGroupedQuery, costLlmPriorQuery } from './cost-rollups';
import { db } from './db';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = `ses_covering_${crypto.randomUUID().slice(0, 8)}`;
const window = { from: new Date(Date.now() - 3 * 86_400_000), to: new Date(Date.now() + 60_000) };

const SIBLING_ACCOUNTS = 199;
const ROWS_PER_ACCOUNT = 50;
// Module scope: afterAll deletes them (the FK cascades take their logs).
const siblings = Array.from({ length: SIBLING_ACCOUNTS }, () => crypto.randomUUID());

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId, name: 'Cost covering index test' },
    ...siblings.map((id) => ({ accountId: id, name: 'Cost covering index sibling' })),
  ]);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'Synthetic',
    repoUrl: 'https://example.test/cost-covering.git',
  });
  // Interleave the pinned account's rows with the siblings' rows so its heap
  // pages are scattered, the way one account's rows sit in a shared prod
  // table. Random created_at inside the window keeps the index order and the
  // heap order unrelated.
  const at = () => new Date(window.from.getTime() + Math.random() * (window.to.getTime() - window.from.getTime() - 1_000));
  const logRow = (owner: string) => ({
    accountId: owner,
    projectId: owner === accountId ? projectId : null,
    sessionId: owner === accountId ? `${sessionId}_${Math.floor(Math.random() * 40)}` : null,
    requestId: crypto.randomUUID(),
    requestedModel: 'test-model',
    resolvedModel: 'test-model',
    provider: 'test',
    status: 200,
    ok: true,
    billingMode: 'credits',
    inputTokens: 100,
    outputTokens: 10,
    finalCost: '0.01',
    createdAt: at(),
  });
  const rows: ReturnType<typeof logRow>[] = [];
  for (let i = 0; i < ROWS_PER_ACCOUNT; i++) {
    rows.push(logRow(accountId));
    for (const sibling of siblings) rows.push(logRow(sibling));
  }
  // postgres.js caps bound parameters per statement; 10,000 rows × 15 columns
  // is over it. Batch at 500 rows.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(gatewayRequestLogs).values(rows.slice(i, i + 500));
  }
  // Clean baseline: the freshly inserted pages are not all-visible until a
  // vacuum runs (the exact degradation KRTX-4638 shipped to prod), so vacuum
  // until the map is clean and every test below starts from the healthy state.
  await vacuumUntilClean();
});

afterAll(async () => {
  // The FK cascades take each account's logs with them.
  await db.delete(accounts).where(inArray(accounts.accountId, [accountId, ...siblings]));
});

/** The plan text of one EXPLAIN (ANALYZE) with every heap-reading scan demoted. */
function explainAnalyzed(query: SQLWrapper): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    const rows = (await tx.execute(
      sql`explain (analyze, costs off) ${query}`,
    )) as unknown as Array<Record<string, string>>;
    return rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

const heapFetches = (plan: string): number => {
  const match = plan.match(/Heap Fetches: (\d+)/);
  if (!match) throw new Error(`no Index Only Scan node in plan:\n${plan}`);
  return Number(match[1]);
};

/**
 * VACUUM (ANALYZE) until the grouped scan is index-only with zero heap
 * fetches, and return the last plan. Under the core-db lane's six-suite
 * parallel load a vacuum pass can skip a page it cannot lock immediately
 * (the skip clears the page's all-visible bit; the next pass processes it),
 * so one pass is not a promise. Vacuum is idempotent and the table is small.
 */
async function vacuumUntilClean(): Promise<string> {
  let plan = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    await db.execute(sql`vacuum (analyze) kortix.gateway_request_logs`);
    plan = await explainAnalyzed(costLlmGroupedQuery({ accountId }, window));
    if (heapFetches(plan) === 0) return plan;
  }
  return plan;
}

test('the account-led LLM cost scans are index-only on idx_gateway_logs_account_time_covering', async () => {
  for (const [name, query] of [
    ['cost-summary grouped scan', costLlmGroupedQuery({ accountId }, window)],
    ['cost-summary prior-window scan', costLlmPriorQuery({ accountId }, window)],
    ['cost-by-project scan', costByProjectLlmQuery(accountId, window)],
  ] as const) {
    const plan = await explainAnalyzed(query);
    expect(plan, name).toContain('Index Only Scan');
    expect(plan, name).toContain('idx_gateway_logs_account_time_covering');
    expect(heapFetches(plan), `${name}: the visibility map is clean, the scan must not touch the heap`).toBe(0);
  }
});

test('a mass update degrades the index-only scan to heap fetches until vacuum (KRTX-4638)', async () => {
  // The backfill's shape: a mass UPDATE writing a column the covering index
  // does not carry. Every updated row moves, every touched page loses its
  // all-visible bit, and the same index-only plan starts heap-fetching —
  // per-row, in production, over every wide row in the 30-60 day window.
  await db
    .update(gatewayRequestLogs)
    .set({ servedModel: sql`${gatewayRequestLogs.resolvedModel}` })
    .where(eq(gatewayRequestLogs.accountId, accountId));
  expect(heapFetches(await explainAnalyzed(costLlmGroupedQuery({ accountId }, window)))).toBeGreaterThan(0);

  // The remediation: VACUUM (ANALYZE) restores the visibility map and the
  // index-only scan stops touching the heap. This is the runbook action
  // KRTX-4638's handoff names for prod.
  const plan = await vacuumUntilClean();
  expect(heapFetches(plan), `the vacuum restores the visibility map, last plan:\n${plan}`).toBe(0);
});
