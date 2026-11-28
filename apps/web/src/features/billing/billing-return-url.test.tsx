import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { ACCOUNT_PANEL_PARAM, hubParamsFromUrl } from '@kortix/ui/internal/stores/account-panel-store';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'synthetic-user' } }),
}));
mock.module('@kortix/ui/internal/lib/onboarding/last-project-cookie', () => ({
  latestProjectPath: () => '/workspaces/start',
}));
const syncedAccounts: Array<string | undefined> = [];
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  syncSubscription: async (accountId?: string) => {
    syncedAccounts.push(accountId);
  },
}));
const { useBillingReturnUrl, BILLING_RETURNS, portalReturnUrl, settlePortalReturn } = await import('./billing-return');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test.each(['team_signup', 'credit_purchase', 'enterprise_contract'] as const)(
  '%s returns to the purchased account billing view',
  (param) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'http://localhost:13000' } },
    });
    let destination = '';
    function Checkout() {
      destination = useBillingReturnUrl()(param);
      return null;
    }
    renderToStaticMarkup(
      <BillingAccountProvider accountId="synthetic-purchased-account">
        <Checkout />
      </BillingAccountProvider>,
    );
    const url = new URL(destination);
    expect(url.origin).toBe('http://localhost:13000');
    expect(url.searchParams.get('accountId')).toBe('synthetic-purchased-account');
    expect(url.searchParams.get('accountTab')).toBe('billing');
    expect(url.searchParams.get(param)).toBe('success');
  },
);

test('unscoped checkout keeps its marker for the server to attach the resolved account', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost:13000' } },
  });
  let destination = '';
  function Checkout() {
    destination = useBillingReturnUrl()('team_signup');
    return null;
  }
  renderToStaticMarkup(
    <BillingAccountProvider accountId={null}>
      <Checkout />
    </BillingAccountProvider>,
  );
  const url = new URL(destination);
  expect(url.pathname).toBe('/workspaces/start');
  expect(url.searchParams.has('accountId')).toBe(false);
  expect(url.searchParams.get('team_signup')).toBe('success');
});

test.each(['team_signup', 'credit_purchase', 'enterprise_contract'] as const)(
  '%s refreshes the purchased account cache',
  async (param) => {
    const queryClient = new QueryClient();
    const accountKey = ['account-state', 'state', { accountId: 'synthetic-purchased-account' }];
    queryClient.setQueryData(accountKey, { synthetic: true });
    const entry = BILLING_RETURNS.find((entry) => entry.param === param);
    expect(entry).toBeDefined();
    await entry?.settle(queryClient, 'synthetic-purchased-account');
    expect(queryClient.getQueryState(accountKey)?.isInvalidated).toBe(true);
    if (param === 'team_signup') expect(syncedAccounts.at(-1)).toBe('synthetic-purchased-account');
    queryClient.clear();
  },
);

// KRTX-1510: the portal's one plan change (a switch to Free) lands on its
// return, not when Stripe's webhook arrives.
test('the portal returns to the Plan page itself, with a marker naming the managed account', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost:13000' } },
  });
  const url = new URL(
    portalReturnUrl('http://localhost:13000/workspaces/synthetic-project/admin/plan', 'synthetic-workspace'),
  );
  expect(url.pathname).toBe('/workspaces/synthetic-project/admin/plan');
  // AccountHubRouter routes any URL carrying a hub key to the hub's section:
  // `accountId` alone sent this return from Plan to /admin (G9 review item).
  expect(url.searchParams.has(ACCOUNT_PANEL_PARAM)).toBe(false);
  expect(hubParamsFromUrl(url.searchParams).toString()).toBe('');
  expect(url.searchParams.get('billing_portal')).toBe('synthetic-workspace');
  expect(new URL(portalReturnUrl('/settings/billing', undefined)).searchParams.get('billing_portal')).toBe('');
});

test('the portal return re-syncs the managed account and re-reads its state', async () => {
  const queryClient = new QueryClient();
  const accountKey = ['account-state', 'state', { accountId: 'synthetic-workspace' }];
  queryClient.setQueryData(accountKey, { synthetic: true });
  await settlePortalReturn(queryClient, 'synthetic-workspace');
  expect(syncedAccounts.at(-1)).toBe('synthetic-workspace');
  expect(queryClient.getQueryState(accountKey)?.isInvalidated).toBe(true);
  queryClient.clear();
});
