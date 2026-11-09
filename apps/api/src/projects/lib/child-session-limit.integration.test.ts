/**
 * Real-Postgres contract for the cap on child sessions one session starts
 * (`child-session-limit.ts`): only this parent's children in this project in
 * the last 10 minutes count, the 40th refuses with a 429 the model reads as
 * "stop", and a workflow runner (its run has its own cap) is never refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessionRuntimeContexts, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { CHILD_SESSION_LIMIT, childSessionLimitRefusal, recentChildSessionCount } from './child-session-limit';
import { db } from '../../shared/db';

const ACCOUNT = crypto.randomUUID();
// One project per account (uq_projects_workspace_account).
const OTHER_ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OTHER_PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const PARENT = crypto.randomUUID();
const RUNNER = crypto.randomUUID();

const row = (sessionId: string, parentSessionId: string | null, createdAt: Date, projectId = PROJECT) => ({
  sessionId,
  accountId: projectId === PROJECT ? ACCOUNT : OTHER_ACCOUNT,
  projectId,
  branchName: sessionId,
  createdBy: USER,
  visibility: 'project' as const,
  agentName: 'mykortix',
  parentSessionId,
  createdAt,
});
const children = (parent: string, n: number, createdAt: Date, projectId = PROJECT) =>
  Array.from({ length: n }, () => row(crypto.randomUUID(), parent, createdAt, projectId));

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'child-limit-test' },
    { accountId: OTHER_ACCOUNT, name: 'child-limit-other' },
  ]);
  await db.insert(projects).values([
    { projectId: PROJECT, accountId: ACCOUNT, name: 'child-limit-test', repoUrl: 'https://example.test/child-limit.git' },
    { projectId: OTHER_PROJECT, accountId: OTHER_ACCOUNT, name: 'child-limit-other', repoUrl: 'https://example.test/child-limit-other.git' },
  ]);
  const now = new Date();
  const old = new Date(Date.now() - 20 * 60_000);
  await db.insert(projectSessions).values([row(PARENT, null, old), row(RUNNER, null, old)]);
  await db.insert(projectSessionRuntimeContexts).values({
    sessionId: RUNNER,
    context: { 'kortix.workflow.run_id': 'run-1' },
    byteSize: 30,
  });
  await db.insert(projectSessions).values([
    // One short of the cap inside the window.
    ...children(PARENT, CHILD_SESSION_LIMIT - 1, now),
    // Older than the window, and in another project: neither counts.
    ...children(PARENT, 5, old),
    ...children(PARENT, 5, now, OTHER_PROJECT),
    ...children(RUNNER, CHILD_SESSION_LIMIT + 5, now),
  ]);
});

afterAll(async () => {
  for (const projectId of [PROJECT, OTHER_PROJECT]) {
    await db.delete(projectSessions).where(eq(projectSessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  for (const accountId of [ACCOUNT, OTHER_ACCOUNT]) await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('the cap on child sessions per parent', () => {
  test('only this parent\'s children in this project in the last 10 minutes count', async () => {
    expect(await recentChildSessionCount(PARENT, PROJECT)).toBe(CHILD_SESSION_LIMIT - 1);
  });

  test('under the cap: no refusal', async () => {
    expect(await childSessionLimitRefusal(PARENT, PROJECT)).toBeNull();
  });

  test('at the cap: 429 CHILD_SESSION_LIMIT that tells the model to stop, with Retry-After', async () => {
    await db.insert(projectSessions).values(children(PARENT, 1, new Date()));
    const refusal = await childSessionLimitRefusal(PARENT, PROJECT);
    expect(refusal?.status).toBe(429);
    expect(refusal?.body).toMatchObject({ code: 'CHILD_SESSION_LIMIT', limit: CHILD_SESSION_LIMIT, window_seconds: 600 });
    expect(String(refusal?.body.error)).toContain('Stop starting new ones: tell the person what keeps failing');
    expect(refusal?.headers).toEqual({ 'Retry-After': '600' });
  });

  test('a workflow runner over the cap is not refused: its run has its own cap', async () => {
    expect(await recentChildSessionCount(RUNNER, PROJECT)).toBe(CHILD_SESSION_LIMIT + 5);
    expect(await childSessionLimitRefusal(RUNNER, PROJECT)).toBeNull();
  });
});
