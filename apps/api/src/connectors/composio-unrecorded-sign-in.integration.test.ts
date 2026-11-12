/**
 * Real-Postgres contract: the first call records a Composio sign-in that
 * finished at Composio when no finalize recorded it.
 *
 * Incident 2026-11-11: an agent started a shared connect with
 * `kortix connectors connect gmail --owner project`. The person finished the
 * sign-in on Composio's own page ("Successfully connected"). That raw link
 * opens no Kortix page, so the Composio `connected_account.activated` webhook
 * was the only finalize left, and it was delivered to another environment.
 * The row kept `connected_account_id: null` and every call answered
 * `needs_auth`, while Composio held an ACTIVE account for that row.
 *
 * Composio is a fake runtime (`setComposioRuntimeForTest`). The connection
 * rows, the SQL and the gateway (`handleCall(makeDbGatewayDeps(...))`) are real.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, connectorActions, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { ComposioRuntime, ComposioSessionLike } from './composio';

// The adapter loads only when `config.COMPOSIO_API_KEY` is set, and config
// reads it once at import. Every Composio call goes to the fake runtime below.
const previousKey = process.env.COMPOSIO_API_KEY;
process.env.COMPOSIO_API_KEY = 'test-composio-key';
const { setComposioRuntimeForTest } = await import('./composio');
const { makeDbGatewayDeps } = await import('./db-deps-gateway');
const { handleCall } = await import('./gateway');
const { db } = await import('../shared/db');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const REQUESTING_SESSION = crypto.randomUUID();
/** The person finished this sign-in at Composio. */
const FINISHED = crypto.randomUUID();
/** The person opened this sign-in and never finished it. */
const ABANDONED = crypto.randomUUID();

const stableUserOf = (connectionId: string) => `kortix-connection:${connectionId}`;
/** Composio's state: the stable users that hold an ACTIVE account. */
const activeAccounts = new Map<string, string>([[stableUserOf(FINISHED), 'ca_finished']]);
/** Tool Router sessions the connect start created, by session id. */
const sessions = new Map<string, string>([
  ['trs_finished', stableUserOf(FINISHED)],
  ['trs_abandoned', stableUserOf(ABANDONED)],
]);
const executed: Array<{ stableUserId: string; toolSlug: string }> = [];

function fakeSession(sessionId: string, stableUserId: string): ComposioSessionLike {
  return {
    sessionId,
    async tools() {
      return [];
    },
    async toolkits() {
      const accountId = activeAccounts.get(stableUserId);
      return {
        items: [
          {
            slug: 'gmail',
            name: 'Gmail',
            isNoAuth: false,
            ...(accountId ? { connection: { isActive: true, connectedAccount: { id: accountId, status: 'ACTIVE' } } } : {}),
          },
        ],
        cursor: undefined,
        totalPages: 1,
      } as never;
    },
    async authorize() {
      throw new Error('this contract starts no new sign-in');
    },
    async execute(toolSlug) {
      executed.push({ stableUserId, toolSlug });
      return { data: { emailAddress: 'person@example.test' }, error: null, logId: 'log_synthetic' } as never;
    },
  };
}

const fakeRuntime: ComposioRuntime = {
  sessions: {
    async create() {
      throw new Error('this contract creates no Tool Router session');
    },
    async use(sessionId) {
      const stableUserId = sessions.get(sessionId);
      if (!stableUserId) throw new Error(`unknown Tool Router session ${sessionId}`);
      return fakeSession(sessionId, stableUserId);
    },
  },
  connectedAccounts: {
    async get() {
      return { state: { val: { displayName: 'Person@Example.test' } } };
    },
  },
};

/** The row a connect start leaves behind: a Composio session, no account yet. */
function startedMetadata(connectionId: string, sessionId: string, authRequestId: string) {
  return {
    provider: 'composio',
    toolkit: 'gmail',
    stable_user_id: stableUserOf(connectionId),
    session_id: sessionId,
    auth_request_id: authRequestId,
    connected_account_id: null,
    is_no_auth: false,
    requesting_session_id: REQUESTING_SESSION,
  };
}

async function rowOf(connectionId: string) {
  const [row] = await db
    .select({
      label: connectorConnections.label,
      status: connectorConnections.status,
      metadata: connectorConnections.metadata,
      updatedAt: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId));
  return row!;
}

function callAs(connectionId: string) {
  const principal = {
    userId: OWNER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId: null,
    subject: { userId: OWNER, groupIds: [] },
    agentGrant: null,
    requestedConnectorAccount: connectionId,
  };
  return handleCall(makeDbGatewayDeps(principal), {
    projectId: PROJECT,
    accountId: ACCOUNT,
    subject: { userId: OWNER, groupIds: [] },
    sessionId: null,
    connectorSlug: 'gmail',
    actionPath: 'get_profile',
    args: {},
  });
}

beforeAll(async () => {
  setComposioRuntimeForTest(fakeRuntime);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'composio-unrecorded-sign-in' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'composio-unrecorded-sign-in',
    repoUrl: 'https://example.test/composio-unrecorded-sign-in.git',
  });
  await db.insert(connectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'gmail',
    name: 'Gmail',
    providerType: 'composio',
    config: { app: 'gmail' },
  });
  await db.insert(connectorActions).values({
    connectorId: CONNECTOR,
    path: 'get_profile',
    name: 'get_profile',
    risk: 'read',
    binding: { kind: 'composio', toolkit: 'gmail', toolSlug: 'GMAIL_GET_PROFILE' },
  });
  await db.insert(connectorConnections).values([
    {
      connectionId: FINISHED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      label: 'Gmail',
      ownerType: 'project',
      metadata: startedMetadata(FINISHED, 'trs_finished', 'ca_finished'),
    },
    {
      connectionId: ABANDONED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      label: 'Private connection',
      ownerType: 'member',
      ownerId: OWNER,
      metadata: startedMetadata(ABANDONED, 'trs_abandoned', 'ca_abandoned'),
    },
  ]);
});

afterAll(async () => {
  setComposioRuntimeForTest(null);
  if (previousKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = previousKey;
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('a sign-in finished at Composio with no finalize: the first call records the account and runs', async () => {
  const result = await callAs(FINISHED);

  expect(result).toMatchObject({
    status: 'ok',
    output: { emailAddress: 'person@example.test' },
    account: { connection_id: FINISHED, owner_type: 'project' },
  });
  expect(executed).toEqual([{ stableUserId: stableUserOf(FINISHED), toolSlug: 'GMAIL_GET_PROFILE' }]);

  // Recorded on the row: the next call, the account list and event triggers read it.
  const row = await rowOf(FINISHED);
  expect(row.status).toBe('active');
  expect(row.label).toBe('person@example.test');
  expect(row.metadata).toMatchObject({
    connected_account_id: 'ca_finished',
    connected_as: 'person@example.test',
    session_id: 'trs_finished',
    requesting_session_id: REQUESTING_SESSION,
  });

  // The next call reads the recorded account and needs no Composio lookup first.
  expect(await callAs(FINISHED)).toMatchObject({ status: 'ok' });
  expect(executed).toHaveLength(2);
});

test('a sign-in the person never finished: the call answers needs_auth and writes nothing', async () => {
  const before = await rowOf(ABANDONED);

  const result = await callAs(ABANDONED);

  expect(result).toMatchObject({ status: 'denied', reason: 'needs_auth' });
  expect(executed.filter((call) => call.stableUserId === stableUserOf(ABANDONED))).toEqual([]);
  const after = await rowOf(ABANDONED);
  expect(after.metadata).toEqual(before.metadata);
  expect(after.updatedAt).toEqual(before.updatedAt);
});
