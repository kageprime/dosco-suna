/**
 * Integration test (real PostgreSQL): a trigger the account cannot run pauses
 * at once and resumes by itself (projects/lib/trigger-setup-pause.ts).
 *
 * Prod audit, 2026-11-11: on accounts with no usable model, triggers saved
 * fine and every fire dead-lettered "No usable model"; on accounts with an
 * empty wallet, cron triggers kept firing (~6.9k fires in 14 days), each one
 * a dead letter.
 *
 * The contract here, through the real cron drain, the real billing gate and
 * the real queries:
 * - a save of a trigger that is on runs the fire's model check; a refusal
 *   pauses it with the reason; a save of an off trigger checks nothing;
 * - the first fire refused for no model or for billing pauses the trigger;
 *   its owner hears once, from the dead letter; the next automatic fire
 *   starts nothing;
 * - the resume pass resumes each pause whose cause is gone, and only those;
 *   it never ends a pause for another cause.
 *
 * The model check is a switch; session creation is a stub. Everything else is real.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, notifications, projectSessions, projectTriggerRuntime, projectTriggerExecutions, projects, sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const NO_MODEL = 'No usable model for this account. Connect a provider key or upgrade the plan, then fire again.';
const OUT_OF_CREDITS = 'Out of credits. Top up or raise your plan to keep your agents running.';

// The model check: null = a usable model, else the refusal.
let modelRefusal: string | null = NO_MODEL;
const realGate = await import('../projects/lib/trigger-model-gate');
mock.module('../projects/lib/trigger-model-gate', () => ({
  ...realGate,
  triggerModelRefusal: async () => modelRefusal,
}));
const creates: string[] = [];
const realSessions = await import('../projects/lib/sessions');
mock.module('../projects/lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { metadata?: Record<string, unknown> }) => {
    creates.push(String(input.metadata?.trigger_slug));
    return { error: { status: 503, body: { error: 'stub: no sandbox in this test' } }, retryable: false };
  },
}));

const { drainTriggerExecutionQueue } = await import('../projects/lib/trigger-scheduler');
const { fireGitTrigger } = await import('../projects/lib/trigger-fire');
const { autoPauseTrigger } = await import('../projects/lib/trigger-run-caps');
const { gateTriggerSetup, resumeSetupPauses, setupPauseCode } = await import('../projects/lib/trigger-setup-pause');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('../projects/lib/trigger-alerts');

const OWNER = crypto.randomUUID();
const MODEL_PAUSE = `auto-paused: no usable model: ${NO_MODEL}`;
const BILLING_PAUSE = `auto-paused: billing: ${OUT_OF_CREDITS}`;
let project: SeededProject;
const emails: string[] = [];

function cronSpec(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: `Trigger ${slug}`,
    type: 'cron',
    agent: 'default',
    model: null,
    enabled: true,
    promptTemplate: 'Write the report.',
    cron: '0 0 * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh',
    pinnedSessionId: null,
    sessionKey: null,
    filter: null,
    ...extra,
  };
}

async function seedTrigger(slug: string, spec: Record<string, unknown> = cronSpec(slug)) {
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id,
    slug,
    triggerType: 'cron',
    enabled: spec.enabled !== false,
    scheduleRevision: 'a'.repeat(64),
    scheduleSpec: spec,
  });
}

async function seedDueSlot(slug: string, spec: Record<string, unknown> = cronSpec(slug)) {
  await db.insert(projectTriggerExecutions).values({
    projectId: project.project_id,
    slug,
    scheduleRevision: 'a'.repeat(64),
    scheduledFor: new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1_000_000)),
    status: 'queued',
    spec,
    payload: { trigger: { slug, type: 'cron', kind: 'git' } },
    availableAt: new Date(Date.now() - 1_000),
  });
}

async function runtimeOf(slug: string) {
  const [row] = await db
    .select({ at: projectTriggerRuntime.autoPausedAt, reason: projectTriggerRuntime.autoPausedReason, resumedAt: projectTriggerRuntime.autoPauseResumedAt })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  return row!;
}

async function newestSlot(slug: string) {
  const [row] = await db
    .select({ status: projectTriggerExecutions.status, attempts: projectTriggerExecutions.attempts, lastError: projectTriggerExecutions.lastError })
    .from(projectTriggerExecutions)
    .where(and(eq(projectTriggerExecutions.projectId, project.project_id), eq(projectTriggerExecutions.slug, slug)))
    .orderBy(sql`${projectTriggerExecutions.createdAt} desc`)
    .limit(1);
  return row!;
}

async function inbox(slug: string) {
  return db
    .select({ userId: notifications.userId, body: notifications.body })
    .from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)));
}

async function projectRow() {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
  return row!;
}

async function setWallet(balance: number) {
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id = ${project.account_id}::uuid`);
  await db.execute(sql`
    INSERT INTO kortix.credit_accounts (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
    VALUES (${project.account_id}::uuid, ${balance}, ${balance}, ${balance}, ${balance}, 'credits')`);
}

async function withBilling<T>(work: () => Promise<T>): Promise<T> {
  const was = config.KORTIX_BILLING_INTERNAL_ENABLED;
  config.KORTIX_BILLING_INTERNAL_ENABLED = true;
  try {
    return await work();
  } finally {
    config.KORTIX_BILLING_INTERNAL_ENABLED = was;
  }
}

async function drainCron() {
  await drainTriggerExecutionQueue(new Date());
  await settleTriggerAlerts();
}

beforeAll(async () => {
  project = await seedProject('trigger-setup-pause');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner' }]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true,
    listDevices: async () => [],
    sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }),
    emailAvailable: () => true,
    sendEmailNow: async ({ userId }) => {
      emails.push(userId);
      return 'sent';
    },
  });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id = ${project.account_id}::uuid`);
  await removeSeeded([project]);
});

describe('a save of a trigger the account has no model for', () => {
  test('pauses a trigger that is on, with the refusal as the reason; the save is not refused', async () => {
    modelRefusal = NO_MODEL;
    await seedTrigger('saved-on');
    const refusal = await gateTriggerSetup({ projectId: project.project_id, accountId: project.account_id, specs: [cronSpec('saved-on') as never] });
    expect(refusal).toBe(NO_MODEL);
    expect(await runtimeOf('saved-on')).toMatchObject({ at: expect.any(Date), reason: MODEL_PAUSE });
    expect(setupPauseCode(MODEL_PAUSE)).toBe('no_usable_model');
  });

  test('checks nothing for a trigger that is off, or one that calls an App', async () => {
    const off = cronSpec('saved-off', { enabled: false });
    const app = cronSpec('saved-app', { target: { app: 'reporter' } });
    await seedTrigger('saved-off', off);
    await seedTrigger('saved-app', app);
    expect(await gateTriggerSetup({ projectId: project.project_id, accountId: project.account_id, specs: [off, app] as never })).toBeNull();
    expect((await runtimeOf('saved-off')).at).toBeNull();
    expect((await runtimeOf('saved-app')).at).toBeNull();
  });

  test('a later save once a model is usable resumes it', async () => {
    modelRefusal = null;
    expect(await gateTriggerSetup({ projectId: project.project_id, accountId: project.account_id, specs: [cronSpec('saved-on') as never] })).toBeNull();
    expect(await runtimeOf('saved-on')).toMatchObject({ at: null, reason: null, resumedAt: expect.any(Date) });
  });
});

describe('a fire refused for no usable model', () => {
  const slug = 'fire-no-model';

  test('dead-letters once and pauses the trigger at once; the owner hears once, from the dead letter', async () => {
    modelRefusal = NO_MODEL;
    await seedTrigger(slug);
    await seedDueSlot(slug);
    emails.length = 0;

    await drainCron();

    expect(await newestSlot(slug)).toEqual({ status: 'dead_lettered', attempts: 1, lastError: NO_MODEL });
    expect(await runtimeOf(slug)).toMatchObject({ at: expect.any(Date), reason: MODEL_PAUSE });
    // One alert: the dead letter's, which names the cause. Email is opt-in for it.
    expect((await inbox(slug)).map((row) => [row.userId, row.body])).toEqual([[OWNER, NO_MODEL]]);
    expect(emails).toEqual([]);
  });

  test('the next automatic fire is skipped with the reason and starts nothing', async () => {
    creates.length = 0;
    const result = await fireGitTrigger({ spec: cronSpec(slug) as never, project: await projectRow(), payload: {}, renderedPrompt: 'Write the report.', source: 'cron' });
    expect(result).toEqual({ status: 'skipped', reason: MODEL_PAUSE });
    expect(creates).toEqual([]);
  });

  test('the resume pass keeps it paused while the refusal holds, and resumes it once a model is usable', async () => {
    expect(await resumeSetupPauses({ projectId: project.project_id })).toBe(0);
    expect((await runtimeOf(slug)).reason).toBe(MODEL_PAUSE);
    modelRefusal = null;
    expect(await resumeSetupPauses({ projectId: project.project_id })).toBe(1);
    expect(await runtimeOf(slug)).toMatchObject({ at: null, reason: null, resumedAt: expect.any(Date) });
  });
});

describe('a fire refused for an empty wallet', () => {
  const slug = 'fire-empty-wallet';
  const spec = cronSpec(slug, { sessionMode: 'reuse' });

  test('dead-letters once and pauses the trigger with the billing reason', async () => {
    modelRefusal = null;
    await seedTrigger(slug, spec);
    const sessionId = await seedSession(project, OWNER);
    await db
      .update(projectSessions)
      .set({ status: 'stopped', metadata: { trigger_kind: 'git', trigger_slug: slug } })
      .where(eq(projectSessions.sessionId, sessionId));
    await setWallet(0);
    await seedDueSlot(slug, spec);
    emails.length = 0;

    await withBilling(drainCron);

    expect(await newestSlot(slug)).toEqual({ status: 'dead_lettered', attempts: 1, lastError: OUT_OF_CREDITS });
    expect(await runtimeOf(slug)).toMatchObject({ at: expect.any(Date), reason: BILLING_PAUSE });
    expect(setupPauseCode(BILLING_PAUSE)).toBe('billing');
    expect(emails).toEqual([]);
  });

  test('stays paused while the wallet is empty; resumes once it can pay for a run', async () => {
    expect(await withBilling(() => resumeSetupPauses({ projectId: project.project_id }))).toBe(0);
    expect((await runtimeOf(slug)).reason).toBe(BILLING_PAUSE);
    await setWallet(50);
    expect(await withBilling(() => resumeSetupPauses({ projectId: project.project_id }))).toBe(1);
    expect((await runtimeOf(slug)).at).toBeNull();
  });

  test('the next fire on a funded wallet passes the billing gate and queues its prompt', async () => {
    const result = await withBilling(async () =>
      fireGitTrigger({ spec: spec as never, project: await projectRow(), payload: {}, renderedPrompt: 'Write the report.', source: 'cron' }),
    );
    expect(result).toMatchObject({ status: 'queued', reason: 'prompt queued for delivery' });
    expect((await runtimeOf(slug)).at).toBeNull();
  });
});

describe('the resume pass never ends a pause for another cause', () => {
  test('a run-cap pause stays, whatever the account can run', async () => {
    modelRefusal = null;
    const slug = 'run-cap-paused';
    await seedTrigger(slug);
    const reason = 'auto-paused: ran at max_runs_per_hour 60 for 2 hours in a row';
    expect(await autoPauseTrigger(project.project_id, slug, reason, new Date())).toBe(true);
    await resumeSetupPauses({ projectId: project.project_id });
    expect(await runtimeOf(slug)).toMatchObject({ at: expect.any(Date), reason });
    expect(setupPauseCode(reason)).toBeNull();
  });
});
