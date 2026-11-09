import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { totalSpendSql } from './llm-spend';
import { llmValueFields } from './llm-value';
import { listProjectGatewaySourceSpend } from './session-costs';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();
beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'LLM value test' });
  await db.insert(projects).values(
    [projectId, otherProjectId].map((id) => ({
      splitPending: true,
      projectId: id,
      accountId,
      name: 'Synthetic',
      repoUrl: 'https://example.test/repo.git',
    })),
  );
});
afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('SQL values reconcile with sources; estimates never alter charges or duplicate across projects', async () => {
  const base = {
    accountId,
    projectId,
    requestedModel: 'codex/gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    provider: 'openai-codex',
    status: 200,
    ok: true,
    billingMode: 'none',
    inputTokens: 1000,
    outputTokens: 100,
    cachedTokens: 500,
  };
  await db.insert(gatewayRequestLogs).values([
    { ...base, requestId: crypto.randomUUID() },
    {
      ...base,
      requestId: crypto.randomUUID(),
      billingMode: 'credits',
      finalCost: '0.01',
    },
    { ...base, requestId: crypto.randomUUID(), resolvedModel: 'unknown' },
    {
      ...base,
      requestId: crypto.randomUUID(),
      // KRTX-4023: the flag is a real column now; the writer sets column and
      // metadata key together (gateway-trace-row.ts), so the seed does too.
      usageEstimated: true,
      metadata: { usageEstimated: true },
    },
    { ...base, requestId: crypto.randomUUID(), cachedTokens: 1001 },
    { ...base, requestId: crypto.randomUUID(), projectId: otherProjectId },
  ]);
  const [sum] = await db
    .select({ ...llmValueFields, actual: totalSpendSql })
    .from(gatewayRequestLogs)
    .where(eq(gatewayRequestLogs.projectId, projectId));
  expect(sum).toEqual({
    estimated_usage_value: 0.0041,
    priced_requests: 2,
    unpriced_requests: 3,
    actual: 0.01,
  });
  const report = await listProjectGatewaySourceSpend({
    accountId,
    projectId,
    hours: 24,
  });
  expect(report.sources).toHaveLength(1);
  expect(report.total.estimated_usage_value).toBeCloseTo(0.0041, 10);
  expect(report.sources[0]?.estimated_usage_value).toBe(report.total.estimated_usage_value);
  expect(report.total.cost).toBe(0.01);
  expect(report.total.priced_requests).toBe(2);
  expect(report.total.unpriced_requests).toBe(3);
  expect(report.valuation.subscription_fee).toBeNull();
  expect(report.valuation.subscription_allocation).toBeNull();
  const other = await listProjectGatewaySourceSpend({
    accountId,
    projectId: otherProjectId,
    hours: 24,
  });
  expect(other.total.estimated_usage_value).toBe(0.00205);
});

// KRTX-4023 rework: an ECS rollout replaces pods gradually, so old writers
// keep inserting rows after the one-shot backfill ran. Their INSERT predates
// the promoted columns — the flag rides in metadata only — and the table is
// insert-only, so nothing heals them later. The fill trigger
// (20261108090000100) lifts the key at insert; without it the gate reads the
// row as not-estimated and prices a usage its own writer marked estimated.
test('a row the old writer inserts during the rollout (the key in metadata, no column) stays unpriced', async () => {
  const id = crypto.randomUUID();
  await db.insert(projects).values({
    projectId: id,
    accountId,
    name: 'Rollout window',
    repoUrl: 'https://example.test/repo.git',
  });
  await db.execute(sql`
    insert into kortix.gateway_request_logs
      (request_id, account_id, project_id, requested_model, resolved_model,
       provider, status, ok, billing_mode, final_cost, input_tokens, output_tokens, cached_tokens, metadata)
    values (${crypto.randomUUID()}, ${accountId}::uuid, ${id}::uuid,
            'codex/gpt-6.1-sol', 'gpt-6.1-sol', 'openai-codex', 200, true, 'none', '0', 1000, 100, 500,
            '{"usageEstimated":true}'::jsonb)
  `);
  const [sum] = await db
    .select({ ...llmValueFields })
    .from(gatewayRequestLogs)
    .where(eq(gatewayRequestLogs.projectId, id));
  expect(sum).toEqual({ estimated_usage_value: null, priced_requests: 0, unpriced_requests: 1 });
});

test('an unsupported-only window remains unknown, never a guessed zero', async () => {
  const id = crypto.randomUUID();
  await db.insert(projects).values({
    splitPending: true,
    projectId: id,
    accountId,
    name: 'Unknown rates',
    repoUrl: 'https://example.test/unknown.git',
  });
  await db.insert(gatewayRequestLogs).values({
    requestId: crypto.randomUUID(),
    accountId,
    projectId: id,
    requestedModel: 'unknown',
    resolvedModel: 'unknown',
    provider: 'unknown',
    status: 200,
    ok: true,
  });
  const report = await listProjectGatewaySourceSpend({
    accountId,
    projectId: id,
    hours: 24,
  });
  expect(report.total.estimated_usage_value).toBeNull();
  expect(report.total.unpriced_requests).toBe(1);
});
