/**
 * Integration test (real local DB): runGatewayUsageQuery — the cross-session,
 * full-history gateway spend + token query.
 *
 * Why this exists: before this layer, every spend view capped out (top-12
 * models, 10k rows, rolling days only), so a gateway fallback model (GLM) sat
 * at ~76% of paid spend for weeks with no way to ask "paid spend by served
 * model across all sessions". These pins prove the aggregation is honest and
 * uncapped: paid wallet vs BYOK provider vs list-price estimate stay separate,
 * fallback spend is attributed to the model that ANSWERED, date boundaries are
 * exact, caller visibility is enforced, and the returned GROUPS paginate past
 * any fixed ceiling.
 *
 * Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projectSessions, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { parseGatewayUsageQuery } from '../shared/gateway-usage-query';
import { runGatewayUsageQuery, type GatewayUsageVisibility } from '../shared/gateway-usage-run';

const tag = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const sid = (id: string) => `${id}-${tag}`;
// A fixed base instant so absolute windows are deterministic.
const BASE = Date.parse('2026-11-10T12:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

const NO_VISIBILITY: GatewayUsageVisibility = { sessionFilter: undefined };

async function seedSession(input: {
  id: string;
  agent?: string;
  initiatorType?: 'member' | 'trigger' | 'channel' | 'api' | 'system' | null;
  initiatorId?: string | null;
  parent?: string | null;
}) {
  await db.insert(projectSessions).values({
    sessionId: sid(input.id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sid(input.id),
    createdBy: OWNER,
    agentName: input.agent ?? 'engineering',
    initiatorType: input.initiatorType ?? null,
    initiatorId: input.initiatorId ?? null,
    parentSessionId: input.parent ? sid(input.parent) : null,
  });
}

async function seedRequest(input: {
  session?: string | null;
  at: number;
  requested: string;
  served?: string;
  provider: string;
  /** 'credits' = paid Kortix wallet (finalCost); 'none' = BYOK (upstreamCost). */
  mode: 'credits' | 'none';
  amount: number;
  ok?: boolean;
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
}) {
  const served = input.served ?? input.requested;
  await db.insert(gatewayRequestLogs).values({
    requestId: `req-${crypto.randomUUID()}`,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: input.session == null ? null : sid(input.session),
    requestedModel: input.requested,
    resolvedModel: served,
    servedModel: served,
    provider: input.provider,
    status: input.ok === false ? 500 : 200,
    ok: input.ok !== false,
    finalCost: input.mode === 'credits' ? String(input.amount) : '0',
    upstreamCost: input.mode === 'none' ? String(input.amount) : '0',
    billingMode: input.mode,
    inputTokens: input.input ?? 0,
    outputTokens: input.output ?? 0,
    cachedTokens: input.cached ?? 0,
    cacheWriteTokens: input.cacheWrite ?? 0,
    metadata: {},
    createdAt: at(input.at),
  });
}

function run(params: Parameters<typeof parseGatewayUsageQuery>[0], visibility = NO_VISIBILITY) {
  return runGatewayUsageQuery({
    accountId: ACCOUNT,
    projectId: PROJECT,
    query: parseGatewayUsageQuery(params),
    visibility,
  });
}

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role) values
      (${OWNER}::uuid, ${`owner-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
  `);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `gw-usage-${tag}` });
  await db.insert(projects).values({
    splitPending: true,
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades projects, sessions, logs
  await db.execute(sql`delete from auth.users where id = ${OWNER}::uuid`);
});

describe('runGatewayUsageQuery — grouping and honesty', () => {
  test('group-by model: fallback spend is attributed to the model that ANSWERED, split by payee', async () => {
    // seo-cycle session whose requests fell back from an own-key model to the
    // Kortix-served GLM, plus a smaller paid Opus leg and a BYOK leg.
    await seedSession({ id: 'seo', initiatorType: 'trigger', initiatorId: 'seo-cycle', agent: 'seo' });
    // 3 GLM requests, requested a different model but SERVED by glm (paid wallet).
    await seedRequest({ session: 'seo', at: 1, requested: 'claude-opus', served: 'glm-5.3-flash', provider: 'kortix', mode: 'credits', amount: 0.8, input: 1000, output: 200, cached: 100 });
    await seedRequest({ session: 'seo', at: 2, requested: 'claude-opus', served: 'glm-5.3-flash', provider: 'kortix', mode: 'credits', amount: 0.9, input: 1200, output: 150 });
    await seedRequest({ session: 'seo', at: 3, requested: 'claude-opus', served: 'glm-5.3-flash', provider: 'kortix', mode: 'credits', amount: 0.7, input: 900, output: 100 });
    // 1 paid Opus request that actually answered as opus.
    await seedRequest({ session: 'seo', at: 4, requested: 'claude-opus', served: 'claude-opus', provider: 'kortix', mode: 'credits', amount: 0.3, input: 500, output: 80 });
    // 1 BYOK request paid to the provider, not the wallet.
    await seedRequest({ session: 'seo', at: 5, requested: 'gpt-x', served: 'gpt-x', provider: 'openai', mode: 'none', amount: 0.25, input: 400, output: 40 });

    const res = await run({ since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'model' });
    const byModel = Object.fromEntries(res.groups.map((g) => [g.model, g]));

    expect(byModel['glm-5.3-flash'].requests).toBe(3);
    expect(byModel['glm-5.3-flash'].kortix_cost).toBeCloseTo(2.4, 10);
    expect(byModel['glm-5.3-flash'].provider_cost).toBe(0);
    expect(byModel['glm-5.3-flash'].total_cost).toBeCloseTo(2.4, 10);
    expect(byModel['claude-opus'].kortix_cost).toBeCloseTo(0.3, 10);
    // The BYOK leg is provider spend, never wallet spend.
    expect(byModel['gpt-x'].kortix_cost).toBe(0);
    expect(byModel['gpt-x'].provider_cost).toBeCloseTo(0.25, 10);
    expect(byModel['gpt-x'].total_cost).toBeCloseTo(0.25, 10);

    // GLM is ~76% of paid wallet spend, reproducing the manual finding.
    const paidTotal = res.totals.kortix_cost;
    expect(paidTotal).toBeCloseTo(2.7, 10);
    expect(byModel['glm-5.3-flash'].kortix_cost / paidTotal).toBeGreaterThan(0.75);
    // Total spend separates wallet from provider.
    expect(res.totals.provider_cost).toBeCloseTo(0.25, 10);
    expect(res.totals.total_cost).toBeCloseTo(2.95, 10);
    // Groups are ordered by total spend desc.
    expect(res.groups[0].model).toBe('glm-5.3-flash');
  });

  test('cache tokens aggregate and the estimate is kept apart from spend', async () => {
    const res = await run({ since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'model' });
    const glm = res.groups.find((g) => g.model === 'glm-5.3-flash')!;
    expect(glm.input_tokens).toBe(1000 + 1200 + 900);
    expect(glm.output_tokens).toBe(200 + 150 + 100);
    expect(glm.cached_tokens).toBe(100);
    // glm is not a priced model under the estimator → no list-price estimate.
    expect(glm.estimated_usage_value).toBeNull();
    expect(glm.unpriced_requests).toBe(3);
  });

  test('group-by source: trigger (own + inherited from parent), unattributed, unknown', async () => {
    // A worker started BY the seo-cycle trigger session: billed to that trigger.
    await seedSession({ id: 'seo-worker', initiatorType: 'member', initiatorId: OWNER, parent: 'seo' });
    await seedRequest({ session: 'seo-worker', at: 6, requested: 'm', provider: 'kortix', mode: 'credits', amount: 0.1 });
    // A member-initiated session (no trigger).
    await seedSession({ id: 'manual', initiatorType: 'member', initiatorId: OWNER });
    await seedRequest({ session: 'manual', at: 7, requested: 'm', provider: 'kortix', mode: 'credits', amount: 0.05 });
    // A sessionless request → 'unattributed'.
    await seedRequest({ session: null, at: 8, requested: 'm', provider: 'kortix', mode: 'credits', amount: 0.02 });

    const res = await run({ since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'source' });
    const bySource = Object.fromEntries(res.groups.map((g) => [g.source, g]));
    // seo-cycle: its own 5 requests + the worker it spawned (parent inheritance).
    expect(bySource['seo-cycle'].requests).toBe(6);
    expect(bySource['member'].requests).toBe(1);
    expect(bySource['unattributed'].requests).toBe(1);
    expect(bySource['unattributed'].kortix_cost).toBeCloseTo(0.02, 10);
  });

  test('group-by agent falls back to unknown when the session is gone', async () => {
    const res = await run({ since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'agent' });
    const byAgent = Object.fromEntries(res.groups.map((g) => [g.agent, g]));
    expect(byAgent['seo']).toBeTruthy();
    // the sessionless request has no session row → agent 'unknown'
    expect(byAgent['unknown'].requests).toBeGreaterThanOrEqual(1);
  });

  test('date boundaries: since is inclusive, until is exclusive', async () => {
    await seedSession({ id: 'edge' });
    await seedRequest({ session: 'edge', at: 24 * 60, requested: 'edge', provider: 'kortix', mode: 'credits', amount: 1 }); // 2026-11-11T12:00
    await seedRequest({ session: 'edge', at: 48 * 60, requested: 'edge', provider: 'kortix', mode: 'credits', amount: 1 }); // 2026-11-12T12:00

    // [11-11T12:00, 11-12T12:00): includes the first edge row, excludes the second.
    const res = await run({
      since: '2026-11-11T12:00:00Z',
      until: '2026-11-12T12:00:00Z',
      group_by: 'model',
    });
    const edge = res.groups.find((g) => g.model === 'edge');
    expect(edge?.requests).toBe(1);
  });

  test('group-by day buckets by UTC calendar day', async () => {
    const res = await run({ since: '2026-11-10T00:00:00Z', until: '2026-11-13T00:00:00Z', group_by: 'day' });
    const byDay = Object.fromEntries(res.groups.map((g) => [g.day, g.requests]));
    expect(byDay['2026-11-11']).toBe(1);
    expect(byDay['2026-11-12']).toBe(1);
  });

  test('combined group-by (source,model) reports a row per pair, source first', async () => {
    const res = await run({
      since: '2026-11-10T12:00:00Z',
      until: '2026-11-11T00:00:00Z',
      group_by: 'source,model',
    });
    expect(res.group_by).toEqual(['source', 'model']);
    const pair = res.groups.find((g) => g.source === 'seo-cycle' && g.model === 'glm-5.3-flash');
    expect(pair?.requests).toBe(3);
  });

  test('grand total (no group-by) sums the whole window', async () => {
    const res = await run({ since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z' });
    expect(res.group_by).toEqual([]);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].requests).toBe(res.totals.requests);
    expect(res.next_cursor).toBeNull();
  });

  test('a rolling days window is resolved to ABSOLUTE bounds in the response (so a drain can freeze it)', async () => {
    const before = Date.now();
    const res = await run({ days: '7', group_by: 'model' });
    const after = Date.now();
    // until is concrete (request time), never null, for a rolling window.
    expect(res.window.until).not.toBeNull();
    const until = Date.parse(res.window.until!);
    expect(until).toBeGreaterThanOrEqual(before - 1000);
    expect(until).toBeLessThanOrEqual(after + 1000);
    // since is until - 7 days, concrete.
    expect(res.window.since).not.toBeNull();
    const since = Date.parse(res.window.since!);
    expect(until - since).toBe(7 * 86_400_000);
    expect(res.window.days).toBe(7);
  });

  test('caller visibility filters session-level groups but model groups stay project-wide', async () => {
    const visibleOnly: GatewayUsageVisibility = {
      sessionFilter: inArray(gatewayRequestLogs.sessionId, [sid('seo')]),
    };
    const sessionView = await run(
      { since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'session' },
      visibleOnly,
    );
    // Only the seo session's groups are visible.
    expect(sessionView.groups.map((g) => g.session)).toEqual([sid('seo')]);

    // The same visibility filter does NOT narrow a model (non-session) query.
    const modelView = await run(
      { since: '2026-11-10T12:00:00Z', until: '2026-11-11T00:00:00Z', group_by: 'model' },
      visibleOnly,
    );
    expect(modelView.groups.some((g) => g.model === 'glm-5.3-flash')).toBe(true);
  });
});

describe('runGatewayUsageQuery — no 10k ceiling, cursor progression', () => {
  const MANY_PROJECT = crypto.randomUUID();
  const MANY_ACCOUNT = crypto.randomUUID();
  const MANY_OWNER = crypto.randomUUID();
  const GROUP_COUNT = 10_050; // deliberately past the old 10k row ceiling

  beforeAll(async () => {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role) values
        (${MANY_OWNER}::uuid, ${`many-${tag}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')
    `);
    await db.insert(accounts).values({ accountId: MANY_ACCOUNT, name: `gw-many-${tag}` });
    await db.insert(projects).values({
      splitPending: true,
      projectId: MANY_PROJECT,
      accountId: MANY_ACCOUNT,
      name: 'many',
      repoUrl: 'https://example.com/many.git',
    });
    // One request per distinct session, bulk-inserted for speed. Grouping by
    // session therefore yields GROUP_COUNT groups — more than any single page.
    await db.execute(sql`
      insert into kortix.gateway_request_logs
        (request_id, account_id, project_id, session_id, requested_model, resolved_model,
         served_model, provider, status, ok, final_cost_precise, upstream_cost_precise,
         billing_mode, input_tokens, output_tokens, created_at)
      select
        'req-' || gs::text || '-' || ${tag},
        ${MANY_ACCOUNT}::uuid,
        ${MANY_PROJECT}::uuid,
        'many-' || gs::text || '-' || ${tag},
        'm', 'm', 'm', 'kortix', 200, true,
        (0.001 * gs)::numeric, 0, 'credits', 10, 5,
        timestamptz '2026-11-10T12:00:00Z'
      from generate_series(1, ${GROUP_COUNT}) as gs
    `);
  });

  afterAll(async () => {
    await db.delete(accounts).where(eq(accounts.accountId, MANY_ACCOUNT));
    await db.execute(sql`delete from auth.users where id = ${MANY_OWNER}::uuid`);
  });

  test('group-by session over >10k groups drains fully via the cursor, no dup, no skip', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let totalsGroups = -1;
    for (;;) {
      const res = await runGatewayUsageQuery({
        accountId: MANY_ACCOUNT,
        projectId: MANY_PROJECT,
        query: parseGatewayUsageQuery({ days: '3650', group_by: 'session', limit: '500', cursor }),
        visibility: NO_VISIBILITY,
      });
      totalsGroups = res.totals.groups;
      for (const g of res.groups) {
        expect(seen.has(g.session!)).toBe(false); // no duplicate across pages
        seen.add(g.session!);
      }
      pages += 1;
      if (!res.next_cursor) break;
      cursor = res.next_cursor;
      expect(pages).toBeLessThan(100); // safety: 10050/500 ≈ 22 pages
    }
    expect(seen.size).toBe(GROUP_COUNT);
    expect(totalsGroups).toBe(GROUP_COUNT); // totals count is uncapped too
    expect(pages).toBe(Math.ceil(GROUP_COUNT / 500));
  });
});
