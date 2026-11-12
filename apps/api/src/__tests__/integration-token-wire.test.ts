/**
 * Characterization for the token wire (KRTX-4573): the exact JSON the token
 * and workspace-key routes render. Pins every field, its value and its order,
 * so the refactor that collapses the six field-by-field wire copies into one
 * `tokenWire` cannot change a byte on `GET /v1/me/tokens`, `GET /v1/tokens`,
 * `POST /v1/tokens`, `GET /v1/workspaces/:id/keys` or the `acts_as: "me"`
 * branch of `POST /v1/workspaces/:id/keys`.
 *
 * The auth middleware is replaced by a stub that sets what it sets for a
 * Supabase browser session; everything under it (IAM, repositories, DB) runs
 * for real against the suite's own migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { accountTokens as tokens, accountMembers, accounts, projects, serviceAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const { accountsRouter } = await import('../accounts/core/app');
const { registerTokenRoutes } = await import('../accounts/core/tokens');
const { registerWorkspaceKeyRoutes } = await import('../accounts/core/workspace-keys');
registerTokenRoutes();
registerWorkspaceKeyRoutes();

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const ME = crypto.randomUUID();
const AGENT_SA = crypto.randomUUID();
const CREATED = '2026-11-01T12:00:00.000Z';
const CREATED_WS = '2026-11-02T12:00:00.000Z';
const CREATED_AGENT = '2026-11-03T12:00:00.000Z';
const EXPIRES = '2027-06-01T00:00:00.000Z';
const MY_EMAIL = 'owner@kortix.test';

/** One synthetic personal token of `ME`, unbound to any workspace. */
const PERSONAL_KEY = '11111111-1111-1111-1111-111111111111' as const;
/** One synthetic workspace-scoped key of `ME` (an ordinary human key). */
const MINE_IN_WS = '22222222-2222-2222-2222-222222222222' as const;
/** One synthetic agent key: bound to the workspace and to a service account. */
const AGENT_KEY = '33333333-3333-3333-3333-333333333333' as const;

const row = (tokenId: string, name: string, createdAt: string, extra: Partial<typeof tokens.$inferInsert> = {}) =>
  ({
    tokenId,
    accountId: ACCOUNT,
    publicKey: `pk_${tokenId.slice(0, 8)}`,
    secretKeyHash: `h_${tokenId.slice(0, 8)}`,
    userId: ME,
    name,
    createdAt: new Date(createdAt),
    expiresAt: new Date(EXPIRES),
    ...extra,
  }) as typeof tokens.$inferInsert;

const pk = PERSONAL_KEY.slice(0, 8);

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, ME as never);
  c.set('userEmail' as never, MY_EMAIL as never);
  c.set('authType' as never, 'supabase' as never);
  await next();
});
app.route('/v1/accounts', accountsRouter);

const mintedTokenIds: string[] = [];

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'token-wire-test' });
  await db.insert(projects).values({
    projectId: WORKSPACE,
    accountId: ACCOUNT,
    name: 'wire-test-ws',
    repoUrl: 'https://example.test/wire.git',
  });
  await insertIntoView(db, accountMembers, { userId: ME, accountId: ACCOUNT, accountRole: 'owner' });
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${ME}::uuid, ${MY_EMAIL}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await db.insert(serviceAccounts).values({
    serviceAccountId: AGENT_SA,
    accountId: ACCOUNT,
    name: 'main',
    agentName: 'main',
    publicPrefix: 'kortix_sa_main…',
    secretHash: 'h_sa',
    createdBy: ME,
  });
  await db.insert(tokens).values([
    row(PERSONAL_KEY, 'my laptop', CREATED),
    row(MINE_IN_WS, 'project scoped', CREATED_WS, { projectId: WORKSPACE }),
    row(AGENT_KEY, 'main', CREATED_AGENT, {
      projectId: WORKSPACE,
      userId: AGENT_SA,
      createdBy: ME,
      serviceAccountId: AGENT_SA,
    }),
  ]);
});

afterAll(async () => {
  for (const tokenId of mintedTokenIds) {
    await db.delete(tokens).where(eq(tokens.tokenId, tokenId));
  }
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades tokens/members/SAs
  await db.execute(sql`delete from auth.users where id = ${ME}::uuid`);
});

// The exact fields the personal list renders today, in this order, with these
// values. A personal key is bound to no workspace, so both id fields are null.
describe('GET /v1/me/tokens — the personal-key wire', () => {
  test('renders the token row byte for byte', async () => {
    const res = await app.request('/v1/accounts/me/tokens');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    const mine = body.find((t: { token_id: string }) => t.token_id === PERSONAL_KEY);
    expect(JSON.stringify(mine)).toBe(JSON.stringify({
      token_id: PERSONAL_KEY,
      name: 'my laptop',
      project_id: null,
      workspace_id: null,
      public_key: `pk_${pk}`,
      status: 'active',
      expires_at: EXPIRES,
      last_used_at: null,
      created_at: CREATED,
      revoked_at: null,
      scope: 'full',
      permissions: null,
      workspace_permissions: null,
      expiry_renews: false,
    }));
  });
});

// The account-wide list carries the row's workspace binding and no secret.
describe('GET /v1/tokens — the account-key wire', () => {
  test('renders the token row byte for byte', async () => {
    const res = await app.request('/v1/accounts/tokens');
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.find((t: { token_id: string }) => t.token_id === MINE_IN_WS);
    expect(JSON.stringify(mine)).toBe(JSON.stringify({
      token_id: MINE_IN_WS,
      name: 'project scoped',
      project_id: WORKSPACE,
      workspace_id: WORKSPACE,
      public_key: `pk_${MINE_IN_WS.slice(0, 8)}`,
      status: 'active',
      expires_at: EXPIRES,
      last_used_at: null,
      created_at: CREATED_WS,
      revoked_at: null,
      scope: 'full',
      permissions: null,
      workspace_permissions: null,
      expiry_renews: false,
    }));
  });
});

// The mint returns the plain token once with secret_key, and never the
// never-known usage fields. Key ORDER is pinned separately from values: the
// mint writes createdAt now(), which the test cannot predetermine.
describe('POST /v1/tokens — the mint wire', () => {
  test('renders the created token with secret_key and no usage fields', async () => {
    await db.delete(tokens).where(eq(tokens.name, 'wire minted'));
    const res = await app.request('/v1/accounts/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wire minted' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    mintedTokenIds.push(body.token_id);
    expect(Object.keys(body)).toEqual([
      'token_id', 'name', 'project_id', 'workspace_id', 'public_key', 'secret_key',
      'status', 'expires_at', 'created_at', 'scope', 'permissions',
      'workspace_permissions', 'expiry_renews',
    ]);
    expect(body.name).toBe('wire minted');
    expect(typeof body.secret_key).toBe('string');
    expect(body.secret_key.startsWith('kortix_pat_')).toBe(true);
    expect(body.project_id).toBeNull();
    expect(body.workspace_id).toBeNull();
    expect(body.scope).toBe('full');
    expect(body.permissions).toBeNull();
    expect(body.workspace_permissions).toBeNull();
    expect(body.expiry_renews).toBe(false);
  });
});

// One key list with every credential kind, newest first, and NO workspace
// fields on the key rows (the AccountToken wire does not render on keys).
describe('GET /v1/workspaces/:id/keys — the workspace-key wire', () => {
  test('renders mine and the agent key byte for byte', async () => {
    const res = await app.request(`/v1/accounts/${WORKSPACE}/keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['keys', 'can_manage_principals', 'agents', 'bots']);
    expect(body.can_manage_principals).toBe(true);
    expect(JSON.stringify(body.keys[1])).toBe(JSON.stringify({
      key_id: MINE_IN_WS,
      name: 'project scoped',
      acts_as: { type: 'me', name: null, service_account_id: null },
      credential: 'token',
      public_key: `pk_${MINE_IN_WS.slice(0, 8)}`,
      status: 'active',
      expires_at: EXPIRES,
      last_used_at: null,
      created_at: CREATED_WS,
      revoked_at: null,
      created_by: ME,
      created_by_email: MY_EMAIL,
      scope: 'full',
      permissions: null,
      workspace_permissions: null,
      expiry_renews: false,
    }));
    expect(JSON.stringify(body.keys[0])).toBe(JSON.stringify({
      key_id: AGENT_KEY,
      name: 'main',
      acts_as: { type: 'agent', name: 'main', service_account_id: AGENT_SA },
      credential: 'token',
      public_key: `pk_${AGENT_KEY.slice(0, 8)}`,
      status: 'active',
      expires_at: EXPIRES,
      last_used_at: null,
      created_at: CREATED_AGENT,
      revoked_at: null,
      created_by: ME,
      created_by_email: MY_EMAIL,
      scope: 'full',
      permissions: null,
      workspace_permissions: null,
      expiry_renews: false,
    }));
  });
});

// The `me` branch of POST …/keys must answer the same key-row shape the list
// renders, from the freshly minted token, with its secret.
describe('POST /v1/workspaces/:id/keys with acts_as "me" — the key mint wire', () => {
  test('renders the created key with secret_key, last_used_at and revoked_at null', async () => {
    const res = await app.request(`/v1/accounts/${WORKSPACE}/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wire me key' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    mintedTokenIds.push(body.key_id);
    expect(Object.keys(body)).toEqual([
      'key_id', 'name', 'acts_as', 'credential', 'public_key', 'status', 'expires_at',
      'last_used_at', 'created_at', 'revoked_at', 'created_by', 'created_by_email',
      'scope', 'permissions', 'workspace_permissions', 'expiry_renews', 'secret_key',
    ]);
    expect(body.name).toBe('wire me key');
    expect(body.acts_as).toEqual({ type: 'me', name: null, service_account_id: null });
    expect(body.credential).toBe('token');
    expect(typeof body.secret_key).toBe('string');
    expect(body.secret_key.startsWith('kortix_pat_')).toBe(true);
    expect(body.created_by).toBe(ME);
    expect(body.created_by_email).toBe(MY_EMAIL);
    expect(body.scope).toBe('full');
    expect(body.permissions).toBeNull();
    expect(body.workspace_permissions).toBeNull();
    expect(body.expiry_renews).toBe(false);
    expect(body.last_used_at).toBeNull();
    expect(body.revoked_at).toBeNull();
  });
});
