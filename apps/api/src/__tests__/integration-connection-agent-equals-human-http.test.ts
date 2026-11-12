/**
 * Integration test (real local PostgreSQL, the real app and auth middleware):
 * AGENT = HUMAN on connector accounts. An agent session acting for a person
 * gets exactly that person's answer on every connector-account write: revive
 * a revoked account, re-credential it, re-pin it, re-create it by label,
 * share a private account, connect the workspace's shared account. The
 * decision is the person's role ∩ the agent's grant and nothing else: an
 * agent whose grant lacks the permission is refused with the standard 403
 * that names the permission, never for being an agent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accountTokens, connectorConnections, connectors, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { app } from '../index';
import { clearAuthorizeCaches } from '../iam/authorize';
import { createAccountToken } from '../repositories/account-tokens';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { type SeededProject, removeSeeded, seedProject, seedSession } from './helpers/integration-fixtures';

const ADMIN = crypto.randomUUID();
const SLUG = 'crm_revoked_guard';
let project: SeededProject;
let connectorId = '';
let shared = '';
let personal = '';
const tokens = { governed: '', borrowed: '', person: '' };
const sessions: string[] = [];

function request(method: string, path: string, token: string, body: unknown = {}) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const p = (rest: string) => `/v1/projects/${project.project_id}${rest}`;
const statusOf = async (connectionId: string) =>
  (await db.select({ status: connectorConnections.status }).from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId)))[0]!.status;

async function liveSession(): Promise<string> {
  const sessionId = await seedSession(project, ADMIN);
  await db.update(projectSessions).set({ agentName: 'worker' }).where(eq(projectSessions.sessionId, sessionId));
  // A session token holds only while its sandbox does.
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    status: 'active',
    externalId: `revoked-guard-${sessionId.slice(0, 8)}`,
  });
  sessions.push(sessionId);
  return sessionId;
}

beforeAll(async () => {
  project = await seedProject('revoked-guard');
  // No git read: the grant reconcile fails at once and keeps the stored grant.
  await db.update(projects).set({ repoUrl: 'file:///nonexistent/revoked-guard.git' }).where(eq(projects.projectId, project.project_id));
  await insertIntoView(db, accountMembers, { accountId: project.account_id, userId: ADMIN, accountRole: 'owner' });
  const [connector] = await db
    .insert(connectors)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      slug: SLUG,
      name: 'CRM',
      providerType: 'http',
      config: { baseUrl: 'https://crm.example.test', auth: { type: 'none' } },
    })
    .returning({ connectorId: connectors.connectorId });
  connectorId = connector!.connectorId;
  const rows = await db
    .insert(connectorConnections)
    .values([
      { accountId: project.account_id, projectId: project.project_id, connectorId, ownerType: 'project', ownerId: null, label: 'Shared CRM', isDefault: true, status: 'active' },
      { accountId: project.account_id, projectId: project.project_id, connectorId, ownerType: 'member', ownerId: ADMIN, label: 'My CRM', isDefault: false, status: 'active' },
    ])
    .returning({ connectionId: connectorConnections.connectionId, label: connectorConnections.label });
  shared = rows.find((r) => r.label === 'Shared CRM')!.connectionId;
  personal = rows.find((r) => r.label === 'My CRM')!.connectionId;

  const grant = { agent: 'worker', permissions: 'all', connectors: 'all', env: 'all' } as never;
  const serviceAccountId = await ensureAgentServiceAccount({ accountId: project.account_id, projectId: project.project_id, agentName: 'worker' });
  // The production agent token: authorizes as the agent's service account.
  tokens.governed = (
    await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, sessionId: await liveSession(), name: 'governed', agentGrant: grant, serviceAccountId })
  ).secretKey;
  // A session that borrows its launcher's authority (the meta agent, a v1 project).
  tokens.borrowed = (
    await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, sessionId: await liveSession(), name: 'borrowed', agentGrant: { agent: 'meta', permissions: 'all', connectors: 'all' } as never })
  ).secretKey;
  // The same person, with no session.
  tokens.person = (await createAccountToken({ accountId: project.account_id, userId: ADMIN, projectId: project.project_id, name: 'person', agentGrant: null })).secretKey;
  clearAuthorizeCaches();
});

afterAll(async () => {
  await db.delete(accountTokens).where(eq(accountTokens.projectId, project.project_id));
  await db.delete(connectorConnections).where(eq(connectorConnections.connectorId, connectorId));
  await db.delete(connectors).where(eq(connectors.connectorId, connectorId));
  // The sandbox identity guard allows the delete once the session is deleted.
  await db.update(projectSessions).set({ metadata: { deletedAt: 'cleanup' } }).where(inArray(projectSessions.sessionId, sessions));
  await db.delete(sessionSandboxes).where(inArray(sessionSandboxes.sessionId, sessions));
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, sessions));
  await removeSeeded([project]);
});

beforeEach(async () => {
  await db.update(connectorConnections).set({ status: 'active' }).where(eq(connectorConnections.connectorId, connectorId));
});

const AGENTS = ['governed', 'borrowed'] as const;

/** Revoke the shared account as the person, then run one write as `token`. */
async function onRevoked(token: string, method: string, path: string, body: unknown) {
  await db.update(connectorConnections).set({ status: 'revoked' }).where(eq(connectorConnections.connectionId, shared));
  const response = await request(method, p(path), token, body);
  return { status: response.status, after: await statusOf(shared) };
}

describe('AGENT = HUMAN on connector accounts — migrated PostgreSQL', () => {
  test('an agent session revives, re-credentials, re-pins and re-creates a revoked account exactly as its person does', async () => {
    for (const [method, path, body] of [
      ['PUT', `/connections/${shared}/activate`, {}],
      ['PUT', `/connections/${shared}/credential`, { value: 'synthetic-key' }],
      ['PUT', `/connections/${shared}/default`, {}],
      ['POST', '/connections', { connector_alias: SLUG, owner_type: 'project', label: 'Shared CRM' }],
    ] as const) {
      const person = await onRevoked(tokens.person, method, path, body);
      expect(person.status).toBeLessThan(300);
      for (const agent of AGENTS) {
        expect({ agent, path, ...(await onRevoked(tokens[agent], method, path, body)) }).toEqual({ agent, path, ...person });
      }
    }
  });

  test("a session acting as its person (My Kortix) shares the person's private account exactly as the person does", async () => {
    for (const who of ['person', 'borrowed'] as const) {
      await db.update(connectorConnections).set({ ownerType: 'member', ownerId: ADMIN }).where(eq(connectorConnections.connectionId, personal));
      const response = await request('POST', p(`/connections/${personal}/share`), tokens[who], { principals: [] });
      expect({ who, status: response.status }).toEqual({ who, status: 200 });
      const [row] = await db.select({ ownerType: connectorConnections.ownerType }).from(connectorConnections).where(eq(connectorConnections.connectionId, personal));
      expect(row!.ownerType).toBe('project');
    }
  });

  test("a governed agent is its own principal: a member's private account is not its to share (404, never a refusal for being an agent)", async () => {
    await db.update(connectorConnections).set({ ownerType: 'member', ownerId: ADMIN }).where(eq(connectorConnections.connectionId, personal));
    const response = await request('POST', p(`/connections/${personal}/share`), tokens.governed, { principals: [] });
    expect(response.status).toBe(404);
  });

  test("starting a workspace-shared connect answers an agent session exactly as its person, never agent_session_forbidden", async () => {
    for (const path of ['connect', 'connect/finalize']) {
      const url = `/v1/connectors/projects/${project.project_id}/connectors/${SLUG}/${path}`;
      const person = await request('POST', url, tokens.person, { owner: 'project' });
      const personBody = await person.json();
      for (const agent of AGENTS) {
        const response = await request('POST', url, tokens[agent], { owner: 'project' });
        expect({ agent, path, status: response.status, body: await response.json() }).toEqual({ agent, path, status: person.status, body: personBody });
      }
    }
  });

  test('every session reads its own workspace record (GET /v1/workspaces/:id), the route `kortix workspaces clone` probes', async () => {
    for (const who of ['person', ...AGENTS] as const) {
      const response = await request('GET', `/v1/workspaces/${project.project_id}`, tokens[who]);
      expect({ who, status: response.status }).toEqual({ who, status: 200 });
    }
  });

  test('an agent whose grant lacks connections.manage is refused by permission, naming it', async () => {
    const narrow = (
      await createAccountToken({
        accountId: project.account_id,
        userId: ADMIN,
        projectId: project.project_id,
        sessionId: await liveSession(),
        name: 'narrow',
        agentGrant: { agent: 'worker', permissions: ['project.connector.write', 'project.connector.read'], connectors: 'all', env: 'all' } as never,
        serviceAccountId: await ensureAgentServiceAccount({ accountId: project.account_id, projectId: project.project_id, agentName: 'worker' }),
      })
    ).secretKey;
    clearAuthorizeCaches();
    const response = await request('POST', `/v1/connectors/projects/${project.project_id}/connectors/${SLUG}/connect`, narrow, { owner: 'project' });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'agent_scope_insufficient', action: 'project.connector.connections.manage' });
    expect(JSON.stringify(body)).not.toMatch(/agent sessions? cannot|an agent cannot/i);
  });
});
