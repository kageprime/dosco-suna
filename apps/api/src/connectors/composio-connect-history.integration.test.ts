import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { ComposioRuntime, ComposioSessionLike } from './composio';

process.env.COMPOSIO_API_KEY = 'test-composio-key';
const { setComposioRuntimeForTest } = await import('./composio');
const { setComposioRestClientForTest } = await import('./composio-catalog-search');
const { dbConnectorRouterDeps } = await import('./db-deps');
const { mergeRequestingSession, recordFinishedComposioAuthorization } = await import('./db-deps-connect');
const { db } = await import('../shared/db');
const { loadConnectionForMutation } = await import('../projects/lib/connection-mutation');
const { finalizeComposioConnect, startComposioConnect } = await import('../projects/lib/connection-hosted-connect');

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const connectorId = crypto.randomUUID();
const userId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
let active = false;
let onToolkitRead: (() => Promise<void>) | undefined;
const session: ComposioSessionLike = {
  sessionId: 'trs_synthetic',
  async tools() { return []; },
  async toolkits() {
    await onToolkitRead?.();
    return { items: [{ slug: 'googlecalendar', name: 'Calendar', isNoAuth: false,
      ...(active ? { connection: { isActive: true, connectedAccount: { id: 'ca_synthetic', status: 'ACTIVE' } } } : {}),
    }], totalPages: 1 };
  },
  async authorize() { return { id: 'auth_synthetic', redirectUrl: 'https://example.test/authorize' }; },
  async execute() { return { data: {}, error: null, logId: 'log_synthetic' }; },
};
const runtime: ComposioRuntime = {
  sessions: { async create() { return session; }, async use() { return session; } },
  connectedAccounts: { async get() { return { state: { val: { displayName: 'Synthetic Calendar' } } }; } },
};

beforeAll(async () => {
  setComposioRuntimeForTest(runtime);
  setComposioRestClientForTest({ toolkits: { async list() { return { items: [] }; } },
    authConfigs: { async list() { return { items: [] }; } } });
  await db.insert(accounts).values({ accountId, name: 'composio-history' });
  await db.insert(projects).values({ projectId, accountId, name: 'composio-history', repoUrl: 'https://example.test/history.git' });
  await db.insert(connectors).values({ connectorId, accountId, projectId, slug: 'calendar', name: 'Calendar', providerType: 'composio', config: { app: 'googlecalendar' } });
  await db.insert(connectorConnections).values({ connectionId, connectorId, accountId, projectId, ownerType: 'project', label: 'Calendar', metadata: { default_slot: 'project' } });
});
afterAll(async () => {
  setComposioRuntimeForTest(null);
  setComposioRestClientForTest(null);
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});
async function listed(sid: string) {
  if (!dbConnectorRouterDeps.listSessionConnectRequests) throw new Error('missing list boundary');
  return dbConnectorRouterDeps.listSessionConnectRequests(projectId, sid, userId);
}
async function start(sid: string | null) {
  if (!dbConnectorRouterDeps.connectorConnect) throw new Error('missing start boundary');
  return dbConnectorRouterDeps.connectorConnect(projectId, 'calendar', userId,
    { success: 'https://example.test/complete' }, sid, 'project');
}
async function finalize() {
  if (!dbConnectorRouterDeps.connectorFinalize) throw new Error('missing finalize boundary');
  return dbConnectorRouterDeps.connectorFinalize(projectId, 'calendar', userId, { connectionId }, 'project');
}
async function reset(sid: string) {
  active = false;
  onToolkitRead = undefined;
  await db.update(connectorConnections).set({ metadata: { default_slot: 'project', requesting_session_id: sid } })
    .where(eq(connectorConnections.connectionId, connectionId));
  await start(sid);
}

test('actual Composio completion survives a subsequent start and sessionless retry', async () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await reset(first);
  expect((await listed(first))[0]?.connected).toBe(false);
  expect(await finalize()).toMatchObject({ connected: false });
  active = true;
  expect(await finalize()).toMatchObject({ connected: true });
  expect((await listed(first))[0]?.connected).toBe(true);
  await start(second);
  await start(null);
  expect((await listed(first)).map(row => row.connection_id)).toEqual([connectionId]);
  expect((await listed(second))[0]?.connected).toBe(true);
});

test('completion archives its original caller while a new session stamps during provider IO', async () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await reset(first);
  active = true;
  onToolkitRead = async () => { onToolkitRead = undefined; await mergeRequestingSession(connectionId, second); };
  expect(await finalize()).toMatchObject({ connected: true });
  expect((await listed(first))[0]?.connected).toBe(true);
  expect((await listed(second))[0]?.connected).toBe(true);
});

test('start preserves history archived by a concurrent completion after its metadata read', async () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await reset(first);
  active = true;
  const [before] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId));
  onToolkitRead = async () => {
    onToolkitRead = undefined;
    await recordFinishedComposioAuthorization({ projectId, slug: 'calendar', connectionId, metadata: before?.metadata ?? {} });
  };
  await start(second);
  await start(crypto.randomUUID());
  expect((await listed(first))[0]?.connected).toBe(true);
  expect((await listed(second))[0]?.connected).toBe(true);
});

test('gateway recovery archives completion before the next actual start', async () => {
  const first = crypto.randomUUID();
  await reset(first);
  active = true;
  const [row] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId));
  expect(await recordFinishedComposioAuthorization({ projectId, slug: 'calendar', connectionId, metadata: row?.metadata ?? {} })).not.toBeNull();
  await start(crypto.randomUUID());
  expect((await listed(first))[0]?.connected).toBe(true);
});

test('account-scoped completion and start preserve the same completed conversation', async () => {
  const first = crypto.randomUUID();
  await reset(first);
  active = true;
  const connection = await loadConnectionForMutation(projectId, connectionId, accountId);
  if (!connection) throw new Error('missing synthetic connection');
  expect(await finalizeComposioConnect(projectId, connectionId, connection, 'googlecalendar', userId))
    .toMatchObject({ connected: true });
  const next = crypto.randomUUID();
  await mergeRequestingSession(connectionId, next);
  await startComposioConnect(projectId, connectionId, connection, 'googlecalendar', {});
  expect((await listed(first))[0]?.connected).toBe(true);
  expect((await listed(next))[0]?.connected).toBe(true);
});

test('repeated completion deduplicates history and revoked rows never confirm', async () => {
  const first = crypto.randomUUID();
  await reset(first);
  active = true;
  await finalize();
  await finalize();
  const [row] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId));
  expect(row?.metadata?.connect_session_ids).toEqual([first]);
  await db.update(connectorConnections).set({ status: 'revoked' }).where(eq(connectorConnections.connectionId, connectionId));
  expect(await finalize()).toMatchObject({ connected: false });
  expect(await listed(first)).toEqual([]);
});
