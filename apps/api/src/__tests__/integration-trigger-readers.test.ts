import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projects, projectSessions, projectSpaces, serviceAccounts } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { sessionListViewerSql, type SessionListViewer } from '../projects/lib/session-list';
import { selectSessionRowsForViewer } from '../projects/lib/session-inventory';
import type { TriggerReaderPrincipal } from '../projects/trigger-reader-policy';
import { triggerReaderPrincipal } from '../projects/trigger-reader-access';
import type { Actor } from '../iam/actor';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const viewerId = crypto.randomUUID();
const dmId = crypto.randomUUID();
const hiddenId = crypto.randomUUID();
const monitorId = crypto.randomUUID();
const metadata = { source: 'trigger:cron', trigger_kind: 'git', trigger_slug: 'daily', trigger_session_readers: { humans: 'members', agents: ['monitor'] } };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'Reader proof' });
  await db.insert(projects).values({ projectId, accountId, name: 'Reader proof', repoUrl: 'https://example.test/readers.git' });
  await db.insert(serviceAccounts).values({ serviceAccountId: monitorId, accountId, projectId, agentName: 'monitor', name: 'Monitor', secretHash: 'synthetic-unused-secret-hash', publicPrefix: 'kortix_sa_synthetic' });
  await db.insert(projectSpaces).values([
    { spaceId: dmId, projectId, accountId, kind: 'dm', name: 'Private', dmUserId: ownerId, dmAgentName: 'default', createdBy: ownerId },
    { spaceId: hiddenId, projectId, accountId, kind: 'channel', visibility: 'private', slug: 'private-reader-proof', name: 'Private', createdBy: ownerId },
  ]);
  await db.insert(projectSessions).values([
    ...(['private', 'restricted', 'project'] as const).map((visibility) => ({ sessionId: crypto.randomUUID(), accountId, projectId, branchName: visibility, createdBy: ownerId, visibility, metadata })),
    { sessionId: crypto.randomUUID(), accountId, projectId, branchName: 'no-policy', createdBy: ownerId, visibility: 'private', metadata: {} },
    { sessionId: crypto.randomUUID(), accountId, projectId, branchName: 'dm', createdBy: ownerId, visibility: 'private', spaceId: dmId, metadata },
    { sessionId: crypto.randomUUID(), accountId, projectId, branchName: 'hidden', createdBy: ownerId, visibility: 'private', spaceId: hiddenId, metadata },
    { sessionId: crypto.randomUUID(), accountId, projectId, branchName: 'deleted', createdBy: ownerId, visibility: 'private', metadata: { ...metadata, deletedAt: new Date().toISOString() } },
    { sessionId: crypto.randomUUID(), accountId, projectId, branchName: 'backend', createdBy: ownerId, visibility: 'private', origin: 'backend', metadata },
  ]);
});

afterAll(async () => { await db.delete(accounts).where(eq(accounts.accountId, accountId)); });

async function selected(principal: TriggerReaderPrincipal, bound: string | null) {
  const viewer: SessionListViewer = { scope: 'visible', viewerId, boundCredentialSessionId: bound, canManageProject: false, accountSessionOversight: false, agentPrincipal: bound !== null, hiddenSpaceIds: new Set([hiddenId]), readerPrincipal: principal };
  const sqlRows = await db.select().from(projectSessions).where(and(eq(projectSessions.projectId, projectId), sessionListViewerSql(viewer)));
  const rows = await db.select().from(projectSessions).where(eq(projectSessions.projectId, projectId));
  const jsRows = selectSessionRowsForViewer({ rows, scope: 'visible', subject: { userId: viewerId, groupIds: [] }, canManageProject: false, callerSessionId: bound, boundCredentialSessionId: bound, agentPrincipal: bound !== null, hiddenSpaceIds: new Set([hiddenId]), readerPrincipal: principal, readerExcludedSpaceIds: new Set([dmId]), grantsBySession: new Map(), runtimeStatusBySession: new Map() }).items;
  return { sql: sqlRows.map((row) => row.branchName).sort(), js: jsRows.map(({ row }) => row.branchName).sort() };
}

describe('trigger reader SQL and inventory fold', () => {
  test('monitor standing resolves its own stored identity, never its launching user', async () => {
    const actor: Actor = { userId: viewerId, accountId, ctx: {}, credential: { kind: 'agent_session', tokenId: crypto.randomUUID(), projectId, sessionId: crypto.randomUUID(), agentGrant: null, serviceAccountId: monitorId, activated: false } };
    expect(await triggerReaderPrincipal(actor, projectId, actor.credential.kind === 'agent_session' ? actor.credential.sessionId : null)).toEqual({ kind: 'agent', name: 'monitor' });
    expect(await triggerReaderPrincipal(actor, crypto.randomUUID(), null)).toEqual({ kind: 'none' });
    await db.update(serviceAccounts).set({ status: 'disabled' }).where(eq(serviceAccounts.serviceAccountId, monitorId));
    expect(await triggerReaderPrincipal(actor, projectId, null)).toEqual({ kind: 'none' });
  });
  test('unrelated session-bound agents keep exactly their existing project sharing reach', async () => {
    const result = await selected({ kind: 'none' }, crypto.randomUUID());
    expect(result.sql).toEqual(['project']);
    expect(result.js).toEqual(result.sql);
  });
  test('named monitors cannot inherit a human grant', async () => {
    const result = await selected({ kind: 'agent', name: 'other' }, crypto.randomUUID());
    expect(result.sql).toEqual(['project']);
    expect(result.js).toEqual(result.sql);
  });
  test('human reader excludes DMs, hidden channels, tombstones and ordinary private sessions', async () => {
    const result = await selected({ kind: 'human', member: true }, null);
    expect(result.sql).toEqual(['backend', 'private', 'project', 'restricted']);
    expect(result.js).toEqual(result.sql);
  });
  test('monitor reader excludes sibling backend sessions', async () => {
    const result = await selected({ kind: 'agent', name: 'monitor' }, crypto.randomUUID());
    expect(result.sql).toEqual(['private', 'project', 'restricted']);
    expect(result.js).toEqual(result.sql);
  });
  test('removed humans lose additive standing', async () => {
    const result = await selected({ kind: 'human', member: false }, null);
    expect(result.sql).toEqual(['project']);
    expect(result.js).toEqual(result.sql);
  });
});
