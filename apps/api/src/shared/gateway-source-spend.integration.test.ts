// LLM spend per source against a real PostgreSQL: which trigger (or member,
// channel, api, system) started the sessions whose gateway requests cost money.
// A worker a trigger session starts is billed to that trigger. A request with
// no session is `unattributed`. Rows outside the window or project are ignored.
import { afterAll, describe, expect, test } from 'bun:test';
import { gatewayRequestLogs, projectSessions } from '@kortix/db';
import { sql } from 'drizzle-orm';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const { db } = await import('./db');
const { seedProject, removeSeeded } = await import('../__tests__/helpers/integration-fixtures');
const { listProjectGatewaySourceSpend, gatewaySourceSpendQuery } = await import('./session-costs');

const MEMBER = '00000000-0000-4000-a000-00000000c0de';

withDb('listProjectGatewaySourceSpend', () => {
  const seeded: Awaited<ReturnType<typeof seedProject>>[] = [];
  afterAll(() => removeSeeded(seeded));

  async function session(
    project: { account_id: string; project_id: string },
    initiator: { type: 'trigger' | 'member' | 'channel' | 'api' | 'system'; id: string } | null,
    parentSessionId: string | null = null,
  ): Promise<string> {
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({
      sessionId,
      accountId: project.account_id,
      projectId: project.project_id,
      branchName: `session/${sessionId}`,
      createdBy: MEMBER,
      initiatorType: initiator?.type ?? null,
      initiatorId: initiator?.id ?? null,
      parentSessionId,
    });
    return sessionId;
  }

  async function request(
    project: { account_id: string; project_id: string },
    sessionId: string | null,
    cost: number,
    input: number,
    ageMinutes = 1,
    ok = true,
  ): Promise<void> {
    await db.insert(gatewayRequestLogs).values({
      requestId: `req_${crypto.randomUUID()}`,
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      requestedModel: 'kortix/test',
      resolvedModel: 'kortix/test',
      provider: 'kortix',
      status: ok ? 200 : 500,
      ok,
      inputTokens: input,
      outputTokens: 10,
      cachedTokens: Math.floor(input / 2),
      billingMode: 'credits',
      finalCost: cost.toFixed(10),
      legacyFinalCost: cost.toFixed(6),
      createdAt: new Date(Date.now() - ageMinutes * 60_000),
    });
  }

  test('rolls spend up to the trigger that started a session or its parent', async () => {
    const project = await seedProject('source-spend');
    const other = await seedProject('source-spend-other', { accountId: project.account_id });
    seeded.push(project, other);

    const intake = await session(project, { type: 'trigger', id: 'software-factory-intake' });
    const worker = await session(project, { type: 'system', id: 'dispatch' }, intake);
    const merge = await session(project, { type: 'trigger', id: 'software-factory-merge' });
    const human = await session(project, { type: 'member', id: MEMBER });

    await request(project, intake, 1, 1000);
    await request(project, worker, 4, 3000, 1, false);
    await request(project, merge, 2, 500);
    await request(project, human, 0.5, 100);
    await request(project, null, 0.25, 50);
    // Outside the 2-hour window: ignored.
    await request(project, merge, 100, 9999, 180);
    // Another project in the same account: ignored.
    const elsewhere = await session(other, { type: 'trigger', id: 'software-factory-merge' });
    await request(other, elsewhere, 100, 9999);

    const out = await listProjectGatewaySourceSpend({
      accountId: project.account_id,
      projectId: project.project_id,
      hours: 2,
    });

    expect(out.window_hours).toBe(2);
    expect(out.sources.map((s) => s.source)).toEqual([
      'software-factory-intake',
      'software-factory-merge',
      'member',
      'unattributed',
    ]);
    const intakeRow = out.sources[0];
    if (!intakeRow) throw new Error('missing intake source');
    expect(intakeRow.sessions).toBe(2);
    expect(intakeRow.requests).toBe(2);
    expect(intakeRow.errors).toBe(1);
    expect(intakeRow.cost).toBeCloseTo(5, 6);
    expect(intakeRow.input_tokens).toBe(4000);
    expect(intakeRow.avg_input_tokens).toBe(2000);
    expect(out.sources[1]?.cost).toBeCloseTo(2, 6);
    expect(out.sources[3]?.sessions).toBe(0);
    expect(out.total.cost).toBeCloseTo(7.75, 6);
    expect(out.total.requests).toBe(5);
  });

  test('counts one session once however many requests it made, and keeps a session with no row as unknown', async () => {
    const project = await seedProject('source-spend-per-session');
    seeded.push(project);

    const busy = await session(project, { type: 'member', id: MEMBER });
    for (let i = 0; i < 3; i++) await request(project, busy, 1, 100 * (i + 1), 1, i !== 2);
    const quiet = await session(project, { type: 'member', id: MEMBER });
    await request(project, quiet, 2, 50);
    // A session id with no project_sessions row: not attributable.
    await request(project, `ghost-${crypto.randomUUID()}`, 0.5, 10);

    const out = await listProjectGatewaySourceSpend({
      accountId: project.account_id,
      projectId: project.project_id,
      hours: 2,
    });

    const member = out.sources.find((s) => s.source === 'member');
    if (!member) throw new Error('missing member source');
    expect(member.sessions).toBe(2);
    expect(member.requests).toBe(4);
    expect(member.errors).toBe(1);
    expect(member.cost).toBeCloseTo(5, 6);
    expect(member.input_tokens).toBe(100 + 200 + 300 + 50);
    const unknown = out.sources.find((s) => s.source === 'unknown');
    if (!unknown) throw new Error('missing unknown source');
    expect(unknown.sessions).toBe(1);
    expect(unknown.requests).toBe(1);
    expect(out.total.sessions).toBe(3);
    expect(out.total.requests).toBe(5);
  });

  test('aggregates the window per session before it joins project_sessions (KRTX-4869)', async () => {
    const { sql: text } = gatewaySourceSpendQuery({ accountId: crypto.randomUUID(), projectId: crypto.randomUUID() }, 2).toSQL();
    const plan = await db.execute(sql.raw(`EXPLAIN (GENERIC_PLAN, FORMAT TEXT) ${text}`));
    const lines = plan.map((row) => String(Object.values(row)[0]));
    // Without it the joins run once per request row, over every session the project ever had.
    expect(lines.some((line) => line.includes('Group Key: gateway_request_logs.session_id'))).toBe(true);
  });

  test('clamps the window to 1..720 hours', async () => {
    const project = await seedProject('source-spend-clamp');
    seeded.push(project);
    const low = await listProjectGatewaySourceSpend({ accountId: project.account_id, projectId: project.project_id, hours: 0 });
    const high = await listProjectGatewaySourceSpend({ accountId: project.account_id, projectId: project.project_id, hours: 10_000 });
    expect(low.window_hours).toBe(1);
    expect(high.window_hours).toBe(720);
    expect(low.sources).toEqual([]);
  });
});
