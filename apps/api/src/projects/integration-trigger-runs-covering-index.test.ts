/**
 * DB suite: the trigger-runs list (`GET /v1/projects/:id/trigger-runs`) pays
 * an LLM-spend aggregate over `kortix.gateway_request_logs` once per
 * returned run (`triggerRunCostsQuery`). That read must be INDEX-ONLY on a
 * covering index — never the wide heap rows (each carries the request/response
 * jsonb payloads) — and a mass UPDATE over the table degrades it to heap
 * fetches until VACUUM restores the visibility map. The planner serves the
 * read from either covering index (`idx_gateway_logs_project_time_covering_v4`
 * keys (project_id, created_at) and prices the run's [claimed_at, run_ended_at]
 * window as an index cond; `idx_gateway_logs_project_session_time` keys the
 * session first), so the contract pins the scan shape, not one index name.
 *
 * Incidents setting this contract:
 *  - KRTX-4022 (2026-11-04): a column read by a gateway aggregate but missing
 *    from the covering index turned the scan into heap fetches of every wide
 *    row — 5-24s queries and 503s at the 25s request deadline.
 *  - KRTX-4638 (2026-11-10): the `gateway_logs_llm_value_backfill` migration
 *    mass-UPDATEd ~70% of the table, clearing every touched page's
 *    all-visible bit; every index-only reader heap-fetched again until a
 *    vacuum (prod still showed 25s deadline guards on this route on
 *    2026-11-12, `db;dur≈25000ms` across n=4-21 statements — KRTX-4795).
 *
 * Seed shape: 199 sibling accounts plus the pinned one, the pinned project's
 * rows interleaved among theirs. A one-project table is perfectly
 * heap-correlated (every heap fetch reads the same handful of pages in index
 * order) and the planner then prices heap fetches as nearly free — the toy
 * table prefers a heap-fetching index scan exactly as the planner prefers
 * nothing on prod. Scattered rows price a heap-fetching scan at one random
 * fetch per row, so the index-only path wins by an order of magnitude, and a
 * column drifting out of the INCLUDE list (which makes index-only illegal)
 * fails the first test.
 *
 * Why the GUCs are only seqscan+bitmapscan: `enable_indexscan = off` also
 * demotes Index Only Scans (verified on PG 17.6), so with index scans enabled
 * and scattered rows the index-only path wins on cost, deterministically,
 * whether or not the table was ANALYZEd.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projectSessions, projectTriggerExecutions, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../shared/db';
import { triggerRunCostsQuery, triggerRunsPageQuery } from './trigger-runs';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const RUNS = 30;
const LOGS_PER_RUN = 30;
// Run s's spend window: [claimed_at, run_ended_at] = 2h apart, 1h wide.
const runClaimedAt = (s: number) => new Date(Date.now() - 3 * 86_400_000 + s * 7_200_000);

const SIBLING_ACCOUNTS = 199;
const ROWS_PER_ACCOUNT = 50;
const PINNED_PER_ROUND = (RUNS * LOGS_PER_RUN) / ROWS_PER_ACCOUNT; // 18, exact
// Module scope: afterAll deletes them (the FK cascades take their logs and runs).
const siblings = Array.from({ length: SIBLING_ACCOUNTS }, () => crypto.randomUUID());

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId, name: 'Trigger runs covering index test' },
    ...siblings.map((id) => ({ accountId: id, name: 'Trigger runs covering index sibling' })),
  ]);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'Synthetic',
    repoUrl: 'https://example.test/trigger-runs-covering.git',
  });
  // 30 closed runs, newest first is the route's read shape. Each run has its
  // own session (one execution per session, the trigger fire shape) and the
  // [claimed_at, run_ended_at] window the correlated aggregate scans.
  // The executions' session_id carries a FK to project_sessions: one row per
  // run's session, the shape every trigger fire writes.
  await db.insert(projectSessions).values(
    Array.from({ length: RUNS }, (_, i) => ({
      sessionId: `ses_tr_covering_${i}`,
      accountId,
      projectId,
      branchName: `trigger-run-${i}`,
    })),
  );
  await db.insert(projectTriggerExecutions).values(
    Array.from({ length: RUNS }, (_, i) => ({
      projectId,
      scheduledFor: runClaimedAt(i),
      slug: 'covering-test',
      scheduleRevision: '0',
      status: 'succeeded',
      spec: {},
      payload: {},
      sessionId: `ses_tr_covering_${i}`,
      claimedAt: runClaimedAt(i),
      runEndedAt: new Date(runClaimedAt(i).getTime() + 3_600_000),
      createdAt: runClaimedAt(i),
    })),
  );
  // Interleave the pinned project's log rows with the siblings' rows so its
  // heap pages are scattered, the way one project's rows sit in a shared prod
  // table. A pinned row's created_at is random inside its own run's window,
  // so index order and heap order stay unrelated. Siblings carry session ids
  // too (the partial index holds every session-bearing row, exactly like
  // prod) but no project.
  const logRow = (owner: 'pinned' | 'sibling', ownerAccount: string, session: number) => ({
    accountId: ownerAccount,
    projectId: owner === 'pinned' ? projectId : null,
    sessionId: owner === 'pinned' ? `ses_tr_covering_${session}` : `ses_sib_${session}`,
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
    createdAt: owner === 'pinned'
      ? new Date(runClaimedAt(session).getTime() + Math.random() * 3_500_000)
      : new Date(Date.now() - 3 * 86_400_000 + Math.random() * 86_400_000),
  });
  const rows: ReturnType<typeof logRow>[] = [];
  for (let i = 0; i < ROWS_PER_ACCOUNT; i++) {
    for (const sibling of siblings) rows.push(logRow('sibling', sibling, i % RUNS));
    for (let r = 0; r < PINNED_PER_ROUND; r++) {
      const run = i * PINNED_PER_ROUND + r;
      rows.push(logRow('pinned', accountId, run % RUNS));
    }
  }
  // postgres.js caps bound parameters per statement; batch like the
  // cost-rollups suite does.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(gatewayRequestLogs).values(rows.slice(i, i + 500));
  }
  // Clean baseline: the freshly inserted pages are not all-visible until a
  // vacuum runs (the exact degradation KRTX-4638 shipped to prod), so vacuum
  // until the map is clean and every test below starts from the healthy state.
  await vacuumUntilClean();
});

afterAll(async () => {
  // The FK cascades take the project's runs and every account's logs with them.
  await db.delete(accounts).where(inArray(accounts.accountId, [accountId, ...siblings]));
});

/** The 25 newest runs, the id set one full page of the route reads spend for. */
async function newestRunIds(): Promise<string[]> {
  const page = await triggerRunsPageQuery({ projectId, cursor: null, limit: 25 });
  return page.slice(0, 25).map((r) => r.row.executionId);
}

/** The plan text of one EXPLAIN (ANALYZE) with every heap-reading scan demoted. */
async function explainAnalyzed(): Promise<string> {
  const query = triggerRunCostsQuery(projectId, await newestRunIds());
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    const rows = (await tx.execute(
      sql`explain (analyze, costs off) ${query}`,
    )) as unknown as Array<Record<string, string>>;
    return rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

/** Every Index Only Scan node must report zero heap fetches for the read to stay off the wide heap rows. */
const heapFetches = (plan: string): number => {
  const matches = plan.match(/Heap Fetches: (\d+)/g);
  if (!matches) throw new Error(`no Index Only Scan node in plan:\n${plan}`);
  return matches.reduce((sum, m) => sum + Number(m.match(/(\d+)/)![1]), 0);
};

/**
 * VACUUM (ANALYZE) until the correlated spend read is index-only with zero
 * heap fetches, and return the last plan. Under the core-db lane's six-suite
 * parallel load a vacuum pass can skip a page it cannot lock immediately
 * (the skip clears the page's all-visible bit; the next pass processes it),
 * so one pass is not a promise. Vacuum is idempotent and the table is small.
 */
async function vacuumUntilClean(): Promise<string> {
  let plan = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    await db.execute(sql`vacuum (analyze) kortix.gateway_request_logs`);
    plan = await explainAnalyzed();
    if (heapFetches(plan) === 0) return plan;
  }
  return plan;
}

test('the runs page query reads no spend, so a hidden row costs no aggregate (KRTX-4854)', () => {
  const { sql: text } = triggerRunsPageQuery({ projectId, cursor: null, limit: 25 }).toSQL();
  expect(text).toContain('project_trigger_executions');
  expect(text).not.toContain('gateway_request_logs');
});

test('the spend read prices exactly the runs it is given', async () => {
  const ids = (await newestRunIds()).slice(0, 3);
  const costs = await triggerRunCostsQuery(projectId, ids);
  expect(costs.map((c) => c.executionId).sort()).toEqual([...ids].sort());
  // 30 pinned log rows of $0.01 fall inside each run's window.
  for (const c of costs) expect(Number(c.costUsd)).toBeCloseTo(0.3, 5);
  expect(await triggerRunCostsQuery(projectId, [])).toEqual([]);
});

test('the trigger-runs correlated spend read is index-only with zero heap fetches', async () => {
  const plan = await explainAnalyzed();
  // The spend query reads only the gateway-log index, so every Index Only Scan
  // node in this plan is the spend aggregate.
  expect(plan).toContain('Index Only Scan');
  expect(plan).toContain('on gateway_request_logs');
  expect(heapFetches(plan), `the visibility map is clean, the read must not touch the heap:\n${plan}`).toBe(0);
});

test('a mass update degrades the correlated spend read to heap fetches until vacuum (KRTX-4795)', async () => {
  // The backfill's shape: a mass UPDATE writing a column the covering index
  // built for this project's shape does not carry (the backfill wrote
  // served_model/usage_estimated). Every updated row moves, every touched
  // page loses its all-visible bit, and the same index-only plan starts
  // heap-fetching — per listed run, in production, over every wide row in
  // the run's window.
  await db
    .update(gatewayRequestLogs)
    .set({ servedModel: sql`${gatewayRequestLogs.resolvedModel}` })
    .where(eq(gatewayRequestLogs.projectId, projectId));
  expect(heapFetches(await explainAnalyzed())).toBeGreaterThan(0);

  // The remediation: VACUUM (ANALYZE) restores the visibility map and the
  // index-only scan stops touching the heap. This is the runbook action the
  // KRTX-4795 handoff names for prod (the same one KRTX-4638 named).
  const plan = await vacuumUntilClean();
  expect(heapFetches(plan), `the vacuum restores the visibility map, last plan:\n${plan}`).toBe(0);
});
