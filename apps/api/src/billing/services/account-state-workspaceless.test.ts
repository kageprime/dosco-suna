import { beforeEach, expect, mock, test } from 'bun:test';
import type { getCreditAccount } from '../repositories/credit-accounts';
let row: Partial<Awaited<ReturnType<typeof getCreditAccount>>> | null = null;
let customers: string[] = [];
let failure = false;
let pages = [{ data: [{ id: 'sub_synthetic', status: 'active' }], has_more: false }];
let reads = 0;
let named: Array<{ data: Array<{ id: string; status: string }>; has_more: boolean; next_page: string | null }> = [];
let searches: Array<{ query: string; limit?: number; page?: string }> = [];
const ID = '00000000-0000-4000-8000-000000000001';
let keyedWorkspace = false;
const realAccounts = await import('../repositories/credit-accounts');
const realCustomers = await import('../repositories/customers');
const realResolve = await import('../../shared/resolve-account');
const { getStripe: realGetStripe } = await import('../../shared/stripe');
mock.module('../../shared/resolve-account', () => ({ ...realResolve, accountExists: async () => keyedWorkspace }));
mock.module('../repositories/credit-accounts', () => ({ ...realAccounts, getCreditAccount: async () => { if (failure) throw new Error('read failed'); return row; } }));
mock.module('../repositories/customers', () => ({ ...realCustomers, listStripeCustomerIdsByAccountId: async () => customers }));
// With no key the real client refuses, so the missing-key case runs the real path.
mock.module('../../shared/stripe', () => ({ getStripe: () => (!config.STRIPE_SECRET_KEY ? realGetStripe() : { subscriptions: { list: async () => { const page = pages[reads++]; if (!page) throw new Error('provider failed'); return page; },
  search: async (params: { query: string; limit?: number; page?: string }) => { searches.push(params); const page = named[searches.length - 1]; if (!page) throw new Error('search failed'); return page; } } }) }));
const { config } = await import('../../config');
const { buildWorkspacelessAccountState } = await import('./account-state');
beforeEach(() => { keyedWorkspace = false; row = null; customers = []; failure = false; reads = 0; pages = [{ data: [{ id: 'sub_synthetic', status: 'active' }], has_more: false }]; named = [{ data: [], has_more: false, next_page: null }]; searches = []; config.STRIPE_SECRET_KEY = 'sk_test_synthetic'; });
test('an empty identity has no subscription and creates no wallet', async () => {
  expect(await buildWorkspacelessAccountState(ID)).toMatchObject({ billing_state: 'no_account', has_active_subscription: false });
  expect(reads).toBe(0);
});
test('a mapped active subscription cannot be reported absent even without a wallet', async () => {
  customers = ['cus_synthetic'];
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
});
test('ended recurring billing is distinct from an active subscription', async () => {
  customers = ['cus_synthetic']; pages[0].data[0].status = 'canceled';
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(false);
});
test('pagination checks every subscription page', async () => {
  customers = ['cus_synthetic'];
  pages = [{ data: [{ id: 'sub_old', status: 'canceled' }], has_more: true }, { data: [{ id: 'sub_live', status: 'past_due' }], has_more: false }];
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
  expect(reads).toBe(2);
});
test('database errors propagate instead of declaring no subscription', async () => {
  failure = true;
  await expect(buildWorkspacelessAccountState(ID)).rejects.toThrow('read failed');
});
test('provider errors propagate instead of declaring no subscription', async () => {
  customers = ['cus_synthetic']; pages = [];
  await expect(buildWorkspacelessAccountState(ID)).rejects.toThrow('provider failed');
});

test('a nonrecurring wallet is not a subscription', async () => {
  row = { tier: 'free', balance: '20', lifetimePurchased: '20' };
  expect(await buildWorkspacelessAccountState(ID)).toMatchObject({ billing_state: 'no_subscription', has_active_subscription: false });
});
for (const status of ['active', 'trialing', 'past_due', 'unpaid', null]) {
  test(`a stored subscription with status ${status} stays fail-closed`, async () => {
    row = { stripeSubscriptionId: 'sub_synthetic', stripeSubscriptionStatus: status };
    expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
  });
}
test('a store subscription remains visible without a workspace', async () => {
  row = { revenuecatSubscriptionId: 'store_synthetic' };
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
});
test('a pending store cancellation stays active until it expires', async () => {
  row = { revenuecatSubscriptionId: 'store_synthetic', revenuecatCancelledAt: '2026-01-01T00:00:00Z', revenuecatCancelAtPeriodEnd: '2099-01-01T00:00:00Z' };
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
});
test('a store cancellation with no known expiry stays fail-closed', async () => {
  row = { revenuecatSubscriptionId: 'store_synthetic', revenuecatCancelledAt: '2026-01-01T00:00:00Z' };
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
});
test('an expired store cancellation is no longer a subscription', async () => {
  row = { revenuecatSubscriptionId: 'store_synthetic', revenuecatCancelledAt: '2026-01-01T00:00:00Z', revenuecatCancelAtPeriodEnd: '2026-02-01T00:00:00Z' };
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(false);
});
test('a workspace the person left that is keyed by their id is refused, not read', async () => {
  keyedWorkspace = true; row = { stripeSubscriptionId: 'sub_synthetic', stripeSubscriptionStatus: 'active' };
  await expect(buildWorkspacelessAccountState(ID)).rejects.toMatchObject({ status: 409, code: 'no_workspace' });
});
test('an unmapped subscription naming the identity cannot be reported absent', async () => {
  named = [{ data: [{ id: 'sub_unmapped', status: 'active' }], has_more: false, next_page: null }];
  expect(await buildWorkspacelessAccountState(ID)).toMatchObject({ billing_state: 'active', has_active_subscription: true });
  expect(searches).toEqual([{ query: `metadata['account_id']:'${ID}'`, limit: 100 }]);
});
test('every page of subscriptions naming the identity is checked', async () => {
  named = [{ data: [{ id: 'sub_old', status: 'canceled' }], has_more: true, next_page: 'page_2' }, { data: [{ id: 'sub_live', status: 'trialing' }], has_more: false, next_page: null }];
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
  expect(searches[1]?.page).toBe('page_2');
});
test('ended subscriptions naming the identity are not a subscription', async () => {
  named = [{ data: [{ id: 'sub_old', status: 'canceled' }, { id: 'sub_lapsed', status: 'incomplete_expired' }], has_more: false, next_page: null }];
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(false);
});
test('a failed search for subscriptions naming the identity fails closed', async () => {
  named = [];
  await expect(buildWorkspacelessAccountState(ID)).rejects.toThrow('search failed');
});
test('an identity that is not a uuid is refused before any lookup', async () => {
  await expect(buildWorkspacelessAccountState("x' OR status:'active")).rejects.toThrow();
  expect(searches).toEqual([]);
});
test('a deployment without a Stripe key cannot report absence', async () => {
  config.STRIPE_SECRET_KEY = '';
  await expect(buildWorkspacelessAccountState(ID)).rejects.toThrow('Missing STRIPE_SECRET_KEY');
  expect(searches).toEqual([]);
});
test('a subscription the wallet proves stays active without a Stripe key', async () => {
  config.STRIPE_SECRET_KEY = ''; row = { stripeSubscriptionId: 'sub_synthetic', stripeSubscriptionStatus: 'active' };
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
});
test('a subscription the wallet proves is reported without a provider read', async () => {
  row = { stripeSubscriptionId: 'sub_synthetic', stripeSubscriptionStatus: 'active' }; customers = ['cus_synthetic']; pages = []; named = [];
  expect((await buildWorkspacelessAccountState(ID)).has_active_subscription).toBe(true);
  expect([reads, searches.length]).toEqual([0, 0]);
});
