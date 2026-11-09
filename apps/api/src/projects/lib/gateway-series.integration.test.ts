import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { buildGatewayTraceRow } from '../../shared/gateway-trace-row';
import { gatewaySeriesQuery, gatewaySeriesRows } from './gateway-series';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'Gateway series test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'Synthetic',
    repoUrl: 'https://example.test/repo.git',
  });
  // 101 requests today with latencies 0..100 ms, so the percentiles are exact.
  await db.insert(gatewayRequestLogs).values(
    Array.from({ length: 101 }, (_, i) => ({
      accountId,
      projectId,
      requestId: crypto.randomUUID(),
      requestedModel: 'gpt-6.1-sol',
      resolvedModel: 'gpt-6.1-sol',
      provider: 'openai-codex',
      status: 200,
      ok: i !== 0,
      billingMode: 'none',
      latencyMs: i,
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 500,
      request: { messages: 'x'.repeat(200) },
    })),
  );
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('the series scans project_id+created_at from the covering index only, never the wide heap rows', async () => {
  // A tiny table plans as a seq scan; this asserts the structural claim: with
  // the heap-fetching scans off, an index-only plan exists only if every
  // column the query reads lives in the index.
  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_indexscan = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    const rows = (await tx.execute(
      sql`explain (costs off) ${gatewaySeriesQuery(projectId, 30)}`,
    )) as unknown as Array<Record<string, string>>;
    return rows.map((row) => Object.values(row)[0]).join('\n');
  });
  expect(plan).toContain('Index Only Scan');
  expect(plan).toContain('idx_gateway_logs_project_time_covering');
});

test('p50/p95/p99 come back per day from one ordered-set aggregate', async () => {
  const rows = await gatewaySeriesRows(projectId, 2);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ requests: 101, errors: 1, p50: 50, p95: 95, p99: 99 });
});

test('a trace whose upstream failures are huge still inserts; the writer bounds metadata and the covering index carries none of it (KRTX-4023 v4)', async () => {
  // Incompressible text, so no pglz shrinkage: the raw value below is what
  // v2/v3's metadata INCLUDE could not hold (btree tuple max ~2.7 KB — the
  // raw insert failed with "index row size" there). v4 replaced that INCLUDE
  // with the promoted columns and no index carries metadata anymore, so the
  // btree limit can never reject a trace row: the WRITER's boundMetadata is
  // the guard that keeps rows sane, and the raw path inserts unchanged.
  const noise = () => Buffer.from(crypto.getRandomValues(new Uint8Array(4000))).toString('base64');
  const attemptFailures = Array.from({ length: 6 }, (_, i) => ({
    attempt: i + 1,
    code: 502,
    message: noise(),
  }));
  const row = buildGatewayTraceRow({
    requestId: crypto.randomUUID(),
    accountId,
    projectId,
    requestedModel: 'gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    provider: 'openai-codex',
    status: 502,
    ok: false,
    metadata: { attemptFailures },
  });
  await db.insert(gatewayRequestLogs).values(row);
  // The bounded write kept the row insertable and the payload within the
  // bound; the unbounded raw value also inserts (no index tuple carries it).
  const rawRow = { ...row, requestId: crypto.randomUUID(), metadata: { attemptFailures } };
  await db.insert(gatewayRequestLogs).values(rawRow);
  const inserted = await db
    .select({ metadata: gatewayRequestLogs.metadata })
    .from(gatewayRequestLogs)
    .where(eq(gatewayRequestLogs.requestId, rawRow.requestId));
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.metadata).toEqual({ attemptFailures });
});
