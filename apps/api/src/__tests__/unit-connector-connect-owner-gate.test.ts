/**
 * THE RULE: who may start or finish a connector sign-in depends on WHOSE
 * account it lands on.
 *
 * - `owner: "me"` (the default) is the caller's own private account. Any
 *   person who may use the workspace connects it (`resolveAccountHolder`, the
 *   rule of `POST /connections/me`). A customer reported that plain members
 *   could not connect their own account: the route asserted
 *   `project.connector.write`, which the built-in `member` role does not hold.
 * - `owner: "project"` is the account the whole workspace uses. It needs
 *   connector administration AND `project.connector.connections.manage`, on the
 *   START and on the FINALIZE alike: finalize persists `connected_account_id`,
 *   so sibling routes on one resource must agree about who may act (CWE-862,
 *   found by strix-security on #7356).
 * - `GET …/sessions/:id/connect-requests` lists what a session waits on to the
 *   person in it, and reads empty for a session the caller cannot open.
 */
import { describe, expect, test } from 'bun:test';
import {
  createConnectorRouter,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
} from '../connectors/router';

const PROJECT = 'proj-1';
const ALICE = 'user-alice';
const HIDDEN_SESSION = '00000000-0000-4000-8000-0000000000aa';

type Caller = { connectorAdmin: boolean; connectionsManager: boolean; member: boolean };

const MANAGER: Caller = { connectorAdmin: true, connectionsManager: true, member: true };
const PLAIN_MEMBER: Caller = { connectorAdmin: false, connectionsManager: false, member: true };
const NON_MEMBER: Caller = { connectorAdmin: false, connectionsManager: false, member: false };

function buildRouter(caller: Caller) {
  const calls = {
    connect: [] as Array<{ userId: string; owner: unknown }>,
    finalize: [] as Array<{ userId: string; owner: unknown }>,
    listed: 0,
  };
  const principal = {
    userId: ALICE,
    accountId: 'acct-1',
    projectId: PROJECT,
    sessionId: null,
    subject: { userId: ALICE, groupIds: [] },
  } as ConnectorPrincipal;
  const allow = (yes: boolean) => async () => (yes ? { accountId: 'acct-1', userId: ALICE } : null);
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async () => principal,
    resolveProjectPrincipal: async () => principal,
    resolveAdmin: allow(caller.connectorAdmin),
    resolveConnectionsManager: allow(caller.connectionsManager),
    resolveAccountHolder: allow(caller.member),
    sessionVisibleTo: async (_c: unknown, _p: string, sessionId: string) => sessionId !== HIDDEN_SESSION,
    connectorConnect: async (_p: string, _s: string, userId: string, _r: unknown, _sid: unknown, owner: unknown) => {
      calls.connect.push({ userId, owner });
      return { provider: 'composio', connectUrl: 'https://example.test/authorize', connectionId: 'conn-1' };
    },
    connectorFinalize: async (_p: string, _s: string, userId: string, _sel: unknown, owner: unknown) => {
      calls.finalize.push({ userId, owner });
      return { provider: 'composio', connected: true, connectionId: 'conn-1' };
    },
    listSessionConnectRequests: async () => {
      calls.listed += 1;
      return [{ slug: 'gmail', app: 'gmail', provider: 'composio', connected: false }];
    },
  } as unknown as ConnectorRouterDeps;
  return { app: createConnectorRouter(deps), calls };
}

const post = (app: ReturnType<typeof createConnectorRouter>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': ALICE },
    body: JSON.stringify(body),
  });

const CONNECT = `/projects/${PROJECT}/connectors/gmail/connect`;
const FINALIZE = `/projects/${PROJECT}/connectors/gmail/connect/finalize`;

describe('owner "me": a plain member connects their own account', () => {
  test('start → 200 with the sign-in URL, for the caller, as their own account', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    const res = await post(app, CONNECT, { owner: 'me' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connectUrl: 'https://example.test/authorize' });
    expect(calls.connect).toEqual([{ userId: ALICE, owner: 'me' }]);
  });

  test('no owner is "me": the start an older client sends', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    expect((await post(app, CONNECT, {})).status).toBe(200);
    expect(calls.connect).toEqual([{ userId: ALICE, owner: 'me' }]);
  });

  test('finalize → 200 for the caller', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    const res = await post(app, FINALIZE, { owner: 'me', connection_id: '00000000-0000-4000-8000-000000000001' });
    expect(res.status).toBe(200);
    expect(calls.finalize).toEqual([{ userId: ALICE, owner: 'me' }]);
  });

  test('a caller who may not use the workspace → 403 on both, nothing started', async () => {
    const { app, calls } = buildRouter(NON_MEMBER);
    expect((await post(app, CONNECT, { owner: 'me' })).status).toBe(403);
    expect((await post(app, FINALIZE, { owner: 'me' })).status).toBe(403);
    expect(calls.connect).toHaveLength(0);
    expect(calls.finalize).toHaveLength(0);
  });
});

describe('owner "project": the shared account stays administration', () => {
  test('a plain member → 403 on start and finalize, nothing touched', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    expect((await post(app, CONNECT, { owner: 'project' })).status).toBe(403);
    expect((await post(app, FINALIZE, { owner: 'project' })).status).toBe(403);
    expect(calls.connect).toHaveLength(0);
    expect(calls.finalize).toHaveLength(0);
  });

  test('connector.write without connections.manage → 403 on start and finalize', async () => {
    const { app, calls } = buildRouter({ ...MANAGER, connectionsManager: false });
    expect((await post(app, CONNECT, { owner: 'project' })).status).toBe(403);
    expect((await post(app, FINALIZE, { owner: 'project', connection_id: '00000000-0000-4000-8000-000000000001' })).status).toBe(403);
    expect(calls.connect).toHaveLength(0);
    expect(calls.finalize).toHaveLength(0);
  });

  test('a manager → 200 on start and finalize', async () => {
    const { app, calls } = buildRouter(MANAGER);
    expect((await post(app, CONNECT, { owner: 'project' })).status).toBe(200);
    expect((await post(app, FINALIZE, { owner: 'project' })).status).toBe(200);
    expect(calls.connect).toEqual([{ userId: ALICE, owner: 'project' }]);
    expect(calls.finalize).toEqual([{ userId: ALICE, owner: 'project' }]);
  });

  test('an unknown owner → 400', async () => {
    const { app, calls } = buildRouter(MANAGER);
    expect((await post(app, CONNECT, { owner: 'everyone' })).status).toBe(400);
    expect(calls.connect).toHaveLength(0);
  });
});

describe('what a session waits on', () => {
  const read = (app: ReturnType<typeof createConnectorRouter>, sessionId: string) =>
    app.request(`/projects/${PROJECT}/sessions/${sessionId}/connect-requests`, {
      headers: { 'x-test-user': ALICE },
    });

  test('a plain member reads their session → 200 with its requests', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    const res = await read(app, '00000000-0000-4000-8000-0000000000bb');
    expect(res.status).toBe(200);
    expect((await res.json()).connectors).toHaveLength(1);
    expect(calls.listed).toBe(1);
  });

  test('a session the caller cannot open reads empty, never its rows', async () => {
    const { app, calls } = buildRouter(PLAIN_MEMBER);
    const res = await read(app, HIDDEN_SESSION);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connectors: [] });
    expect(calls.listed).toBe(0);
  });

  test('a caller who may not use the workspace → 403', async () => {
    const { app } = buildRouter(NON_MEMBER);
    expect((await read(app, '00000000-0000-4000-8000-0000000000bb')).status).toBe(403);
  });
});
