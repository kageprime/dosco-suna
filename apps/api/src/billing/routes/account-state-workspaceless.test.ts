import { beforeEach, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { noWorkspaceError } from '../../shared/no-workspace';

let failure: Error | null = null;
let authType: 'supabase' | 'pat' = 'supabase';
let serviceFailure = false;
const realDb = await import('../../shared/db');
mock.module('../../shared/db', () => ({ ...realDb, hasDatabase: true }));
mock.module('../../middleware/resolve-account', () => ({
  resolveScopedAccountId: async () => { throw failure ?? noWorkspaceError(); },
}));
mock.module('../services/account-state', () => ({
  buildAccountState: async () => { throw new Error('must not build a wallet'); },
  buildMinimalAccountState: async () => { throw new Error('must not build a wallet'); },
  buildLocalAccountState: () => ({ has_active_subscription: false }),
  buildWorkspacelessAccountState: async () => { if (serviceFailure) throw new Error('provider unavailable'); return { has_active_subscription: false, billing_state: 'no_account', subscription: { status: 'no_subscription' } }; },
}));
const { accountStateRouter } = await import('./account-state');
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => { c.set('userId', '00000000-0000-4000-8000-000000000001'); c.set('authType', authType); await next(); });
app.route('/state', accountStateRouter);
beforeEach(() => { failure = null; authType = 'supabase'; serviceFailure = false; });
for (const path of ['/state', '/state/minimal']) {
  test(`${path} returns an identity billing read without a workspace`, async () => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ has_active_subscription: false, billing_state: 'no_account' });
  });
  test(`${path} never treats a failed membership lookup as no subscription`, async () => {
    failure = new Error('database unavailable');
    const res = await app.request(path);
    expect(res.status).toBe(500);
  });
}

test('a provider failure never produces a successful absence response', async () => {
  serviceFailure = true;
  expect((await app.request('/state')).status).toBe(500);
});
test('a named workspace cannot use the identity fallback', async () => {
  expect((await app.request('/state?account_id=00000000-0000-4000-8000-000000000002')).status).toBe(409);
});
test('a token cannot use the identity fallback', async () => {
  authType = 'pat';
  expect((await app.request('/state')).status).toBe(409);
});
