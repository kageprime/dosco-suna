import { expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

const sessions: Array<{ params: unknown; options: unknown }> = [];
const purchases: unknown[] = [];
let price: string | null = null;
let currentConfig = {
  STRIPE_SECRET_KEY: 'sk_test_synthetic',
  PAYSTACK_SECRET_KEY: undefined as string | undefined,
};
mock.module('../../config', () => ({
  get config() {
    return currentConfig;
  },
}));
mock.module('../services/paystack', () => ({
  createPaystackCreditCheckout: async (params: any) => ({
    checkout_url: 'https://checkout.paystack.com/psk_test',
    reference: 'psk_ref_123',
  }),
}));
mock.module('../../shared/stripe', () => ({ getStripe: () => ({ checkout: { sessions: {
  create: async (params: unknown, options: unknown) => {
    sessions.push({ params, options });
    return { url: 'https://example.test/checkout' };
  },
} } }) }));
mock.module('../services/subscriptions', () => ({ getOrCreateStripeCustomer: async () => 'cus_synthetic' }));
mock.module('../services/tiers', () => ({ resolveCreditPriceId: () => price }));
mock.module('../services/billing-cache', () => ({ resolveAccountBilling: async () => ({ entitlements: { canPurchaseCredits: true } }) }));
mock.module('../../middleware/resolve-account', () => ({ resolveScopedAccountId: async () => 'acct_synthetic' }));
// A custom role without billing.read: the read gate refuses before any ledger query.
let billingReadDenied = false;
mock.module('../http-require-billing-write', () => ({
  resolveBillingWriteAccountId: async () => 'acct_synthetic',
  resolveBillingReadAccountId: async () => {
    if (billingReadDenied) throw new HTTPException(403, { message: "You don't have permission to view billing." });
    return 'acct_synthetic';
  },
}));
mock.module('../repositories/transactions', () => ({
  insertPurchase: async (input: unknown) => { purchases.push(input); return { id: 'purchase_synthetic' }; },
  getTransactions: async () => ({}), getTransactionsSummary: async () => ({}), getUsageRecords: async () => ({}),
}));
const { paymentsRouter } = await import('./payments');

test.each([null, 'price_synthetic'])('credit checkout preserves payload for catalog price %s and disables Link on Basil', async (catalogPrice) => {
  price = catalogPrice;
  sessions.length = 0;
  purchases.length = 0;
  const response = await paymentsRouter.request('/purchase-credits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: 25.5, success_url: 'https://example.test/success', cancel_url: 'https://example.test/cancel' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ checkout_url: 'https://example.test/checkout' });
  expect(purchases).toEqual([{ accountId: 'acct_synthetic', amountDollars: '25.5', status: 'pending', description: 'Credit purchase: 2,550 credits ($25.5)', provider: 'stripe' }]);
  expect(sessions).toEqual([{
    params: {
      customer: 'cus_synthetic', mode: 'payment',
      line_items: catalogPrice ? [{ price: catalogPrice, quantity: 1 }] : [{
        price_data: { currency: 'usd', unit_amount: 2550, product_data: { name: '$25.5 Credits' } }, quantity: 1,
      }],
      success_url: 'https://example.test/success?accountId=acct_synthetic&accountTab=billing', cancel_url: 'https://example.test/cancel',
      metadata: { account_id: 'acct_synthetic', purchase_id: 'purchase_synthetic', type: 'credit_purchase' },
      wallet_options: { link: { display: 'never' } },
    },
    options: { apiVersion: '2025-04-30.basil' },
  }]);
});

test.each(['/transactions', '/transactions/summary', '/credit-usage', '/auto-topup/settings', '/auto-topup/setup-status'])(
  'GET %s answers 403 without billing.read',
  async (path) => {
    billingReadDenied = true;
    try {
      expect((await paymentsRouter.request(path)).status).toBe(403);
    } finally {
      billingReadDenied = false;
    }
  },
);

test('credit checkout routes through Paystack when provider is paystack or Stripe is unconfigured', async () => {
  currentConfig.STRIPE_SECRET_KEY = '' as any;
  currentConfig.PAYSTACK_SECRET_KEY = 'sk_test_paystack';
  try {
    const response = await paymentsRouter.request('/purchase-credits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 50, provider: 'paystack' }),
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ checkout_url: 'https://checkout.paystack.com/psk_test' });
  } finally {
    currentConfig.STRIPE_SECRET_KEY = 'sk_test_synthetic';
    currentConfig.PAYSTACK_SECRET_KEY = undefined;
  }
});
