import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountMemberships, accounts, projects, projectSessions, projectTriggerExecutions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { recordPendingPermission } from '../projects/lib/pending-permissions';
import { canAccessSandboxSession } from '../shared/preview-ownership';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const privateId = crypto.randomUUID();
const slug = 'reader-proof';
let token = '';
let permissionId = '';
const prefix = `/v1/workspaces/${projectId}`;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'HTTP reader proof' });
  await db.insert(projects).values({ projectId, accountId, name: 'HTTP reader proof', repoUrl: 'https://example.test/readers.git' });
  await insertIntoView(db, accountMembers, [
    { accountId, userId: ownerId, accountRole: 'owner' },
    { accountId, userId: memberId, accountRole: 'member' },
  ]);
  await db.insert(projectSessions).values([
    { sessionId, projectId, accountId, branchName: sessionId, createdBy: ownerId, visibility: 'private', status: 'stopped', metadata: { source: 'trigger:cron', trigger_kind: 'git', trigger_slug: slug, trigger_session_readers: { humans: 'members', agents: [] } } },
    { sessionId: privateId, projectId, accountId, branchName: privateId, createdBy: ownerId, visibility: 'private', status: 'stopped', metadata: {} },
  ]);
  await db.insert(projectTriggerExecutions).values({ executionId: crypto.randomUUID(), projectId, slug, scheduleRevision: 'reader-proof', scheduledFor: new Date(), spec: {}, source: 'manual', status: 'succeeded', sessionId, runStatus: 'failed', runError: 'Synthetic turn failure', runEndedAt: new Date(), completedAt: new Date(), payload: {} });
  token = (await createAccountToken({ accountId, userId: memberId, name: 'Reader proof' })).secretKey;
  const ask = await recordPendingPermission({ accountId, projectId, sessionId, surfaceSessionId: sessionId, requestId: 'reader-permission', runtimeSessionId: 'ses_reader', tool: 'bash', permission: 'bash', patterns: ['true'], args: { command: 'true' }, argsHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  if (!ask) throw new Error('permission fixture was not stored');
  permissionId = ask.id;
});

afterAll(async () => { await db.delete(accounts).where(eq(accounts.accountId, accountId)); });

async function request(path: string, method = 'GET', body?: object) {
  return app.request(prefix + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe('reader policy through authenticated HTTP routes', () => {
  test('member reads trigger session and run while ordinary private session remains unknown', async () => {
    const read = await request(`/sessions/${sessionId}`);
    expect(read.status).toBe(200);
    expect((await read.json()).session_id).toBe(sessionId);
    expect((await request(`/sessions/${privateId}`)).status).toBe(404);
    const runs = await request(`/triggers/${slug}/runs`);
    expect(runs.status).toBe(200);
    expect((await runs.json()).runs).toEqual([expect.objectContaining({ session_id: sessionId, status: 'fired', run_status: 'failed', run_error: 'Synthetic turn failure' })]);
  });
  test('reader-only access grants no mutation even to a member who can start their own sessions', async () => {
    for (const [method, path, body] of [
      ['POST', `/sessions/${sessionId}/start`, {}],
      ['POST', `/sessions/${sessionId}/restart`, {}],
      ['POST', `/sessions/${sessionId}/stop`, {}],
      ['DELETE', `/sessions/${sessionId}`, {}],
      ['PATCH', `/sessions/${sessionId}`, { name: 'Unauthorized rename' }],
      ['POST', `/sessions/${sessionId}/reload`, {}],
      ['PUT', `/sessions/${sessionId}/scope`, { secrets: [] }],
      ['PUT', `/sessions/${sessionId}/sharing`, { mode: 'project' }],
      ['POST', `/asks/permission:${permissionId}/answer`, { reply: 'once' }],
      ['POST', `/sessions/${sessionId}/prompts`, { client_message_id: 'reader-denied', parts: [{ type: 'text', text: 'Unauthorized prompt' }] }],
    ] as const) {
      const response = await request(path, method, body);
      expect([403, 404]).toContain(response.status);
    }
  });
  test('reader does not gain writable runtime proxy access', async () => {
    expect(await canAccessSandboxSession({ sessionId, projectId, accountId, userId: memberId, callerSessionId: null, boundCredentialSessionId: null })).toBe(false);
  });
  test('membership removal revokes additive reader standing on the next request', async () => {
    await db.delete(accountMemberships).where(eq(accountMemberships.userId, memberId));
    expect([403, 404]).toContain((await request(`/sessions/${sessionId}`)).status);
  });
});
