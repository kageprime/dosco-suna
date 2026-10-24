import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

const webhookSecret = 'whsec_test_secret_12345';
const secretKey = 'sk_test_paystack_secret';
const usdNgnRate = 1600;

// Config mock
mock.module('../../config', () => ({
  config: {
    PAYSTACK_API_URL: 'https://api.paystack.co',
    PAYSTACK_SECRET_KEY: secretKey,
    PAYSTACK_WEBHOOK_SECRET: webhookSecret,
    PAYSTACK_USD_NGN_RATE: usdNgnRate,
  },
}));

// Mock repositories and external services
let mockPurchases: any[] = [];
let mockCreditAccounts: Record<string, any> = {};
let mockBillingCustomers: any[] = [];
let mockWalletGrants: any[] = [];
let mockStripeSyncs: any[] = [];

mock.module('../repositories/transactions', () => ({
  insertPurchase: async (data: any) => {
    const id = `pur_${mockPurchases.length + 1}`;
    const row = { id, ...data };
    mockPurchases.push(row);
    return row;
  },
  updatePurchaseStatus: async (id: string, status: string) => {
    const p = mockPurchases.find((x) => x.id === id);
    if (p) p.status = status;
  },
}));

mock.module('../repositories/customers', () => ({
  upsertCustomer: async (c: any) => {
    mockBillingCustomers.push(c);
  },
}));

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async (accountId: string) => mockCreditAccounts[accountId] ?? null,
  updateCreditAccount: async (accountId: string, patch: any) => {
    mockCreditAccounts[accountId] = { ...mockCreditAccounts[accountId], ...patch };
  },
}));

mock.module('../wallet', () => ({
  wallet: {
    grant: async (grant: any) => {
      mockWalletGrants.push(grant);
      return { granted: grant.amount };
    },
  },
}));

mock.module('./account-write-owner', () => ({
  applyStripeSync: async (accountId: string, patch: any, reason: any) => {
    mockStripeSyncs.push({ accountId, patch, reason });
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    select: (fields?: any) => ({
      from: (table: any) => ({
        where: (cond: any) => {
          const res: any = Promise.resolve(mockBillingCustomers);
          res.limit = (n: number) => {
            if (mockPurchases.length > 0) {
              return Promise.resolve([mockPurchases[mockPurchases.length - 1]]);
            }
            return Promise.resolve(mockBillingCustomers);
          };
          return res;
        },
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: (cond: any) => Promise.resolve(),
      }),
    }),
  },
}));

// Mock fetch for Paystack REST calls
let fetchCalls: { url: string; method: string; body?: any }[] = [];

beforeEach(() => {
  fetchCalls = [];
  mockPurchases = [];
  mockCreditAccounts = {};
  mockBillingCustomers = [];
  mockWalletGrants = [];
  mockStripeSyncs = [];

  globalThis.fetch = mock(async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ url: u, method, body });

    // Handle Paystack endpoints
    if (u.includes('/transaction/initialize')) {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: `https://checkout.paystack.com/${body?.reference ?? 'ref'}`,
            access_code: `acc_${body?.reference ?? 'ref'}`,
            reference: body?.reference ?? 'ref',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/customer')) {
      return new Response(
        JSON.stringify({
          status: true,
          data: { customer_code: `CUS_${body?.email ?? 'test'}` },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/plan') && method === 'GET') {
      return new Response(
        JSON.stringify({
          status: true,
          data: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/plan') && method === 'POST') {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            plan_code: `PLN_${body?.name ?? 'custom'}`,
            name: body?.name,
            amount: body?.amount,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.includes('/subscription/disable')) {
      return new Response(
        JSON.stringify({
          status: true,
          message: 'Subscription disabled successfully',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ status: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
});

const {
  verifyPaystackSignature,
  processPaystackWebhook,
  createPaystackCreditCheckout,
  createPaystackSubscriptionCheckout,
  cancelPaystackSubscription,
} = await import('./paystack');

describe('verifyPaystackSignature', () => {
  test('returns false when signature is missing or empty', () => {
    expect(verifyPaystackSignature('{"test":1}', undefined)).toBe(false);
    expect(verifyPaystackSignature('{"test":1}', '')).toBe(false);
  });

  test('returns false when signature does not match body HMAC', () => {
    const rawBody = '{"event":"charge.success"}';
    const fakeSignature = 'bad_signature_deadbeef';
    expect(verifyPaystackSignature(rawBody, fakeSignature)).toBe(false);
  });

  test('returns true when signature matches sha512 HMAC of raw body', () => {
    const rawBody = '{"event":"charge.success","data":{"amount":500000}}';
    const validSignature = createHmac('sha512', webhookSecret)
      .update(rawBody)
      .digest('hex');
    expect(verifyPaystackSignature(rawBody, validSignature)).toBe(true);
  });
});

describe('createPaystackCreditCheckout', () => {
  test('computes NGN subunits at rate and initializes transaction', async () => {
    const result = await createPaystackCreditCheckout({
      accountId: 'acc-123',
      email: 'buyer@example.com',
      amount: 25, // $25 * 1600 = 40,000 NGN = 4,000,000 kobo
      successUrl: 'https://example.com/return',
    });

    expect(result.checkout_url).toContain('https://checkout.paystack.com/');
    expect(result.reference).toMatch(/^psk_/);

    const initCall = fetchCalls.find((c) => c.url.includes('/transaction/initialize'));
    expect(initCall).toBeDefined();
    expect(initCall?.body?.email).toBe('buyer@example.com');
    expect(initCall?.body?.currency).toBe('NGN');
    expect(initCall?.body?.amount).toBe(4000000);
    expect(initCall?.body?.metadata?.account_id).toBe('acc-123');
    expect(initCall?.body?.metadata?.type).toBe('credit_purchase');
  });
});

describe('createPaystackSubscriptionCheckout', () => {
  test('ensures credits plan and creates subscription transaction', async () => {
    const result = await createPaystackSubscriptionCheckout({
      accountId: 'acc-456',
      email: 'sub@example.com',
      monthlyUsd: 100, // $100 * 1600 = 160,000 NGN = 16,000,000 kobo
      successUrl: 'https://example.com/sub-return',
    });

    expect(result.status).toBe('checkout_created');
    expect(result.monthly_usd).toBe(100);
    expect(result.checkout_url).toContain('https://checkout.paystack.com/');

    const planCall = fetchCalls.find((c) => c.url.includes('/plan') && c.method === 'POST');
    expect(planCall).toBeDefined();
    expect(planCall?.body?.name).toBe('dosco_credits_100');
    expect(planCall?.body?.amount).toBe(16000000);

    const initCall = fetchCalls.find((c) => c.url.includes('/transaction/initialize'));
    expect(initCall).toBeDefined();
    expect(initCall?.body?.plan).toBe('PLN_dosco_credits_100');
    expect(initCall?.body?.metadata?.monthly_usd).toBe(100);
    expect(initCall?.body?.metadata?.type).toBe('subscription');
  });
});

describe('cancelPaystackSubscription', () => {
  test('throws BillingError when account has no subscription code', async () => {
    mockCreditAccounts['acc-nosub'] = { accountId: 'acc-nosub' };
    await expect(cancelPaystackSubscription('acc-nosub')).rejects.toThrow(
      'Account has no Paystack subscription to cancel',
    );
  });

  test('calls disableSubscription when code and token exist', async () => {
    mockCreditAccounts['acc-sub'] = {
      accountId: 'acc-sub',
      paystackSubscriptionCode: 'SUB_123',
      paystackEmailToken: 'tok_abc',
    };
    const res = await cancelPaystackSubscription('acc-sub');
    expect(res.ok).toBe(true);

    const disableCall = fetchCalls.find((c) => c.url.includes('/subscription/disable'));
    expect(disableCall).toBeDefined();
    expect(disableCall?.body).toEqual({ code: 'SUB_123', token: 'tok_abc' });
  });
});

describe('processPaystackWebhook', () => {
  function sign(body: string): string {
    return createHmac('sha512', webhookSecret).update(body).digest('hex');
  }

  test('rejects unsigned webhook request', async () => {
    await expect(processPaystackWebhook('{}', undefined)).rejects.toThrow(
      'Invalid Paystack signature',
    );
  });

  test('handles unknown event safely', async () => {
    const payload = JSON.stringify({ event: 'transfer.success', data: {} });
    const result = await processPaystackWebhook(payload, sign(payload));
    expect(result).toEqual({ received: true, event: 'transfer.success' });
  });

  test('handles charge.success for subscription: grants tier credits and syncs plan', async () => {
    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        status: 'success',
        reference: 'psk_sub_charge_1',
        currency: 'NGN',
        amount: 8000000, // 80,000 NGN = $50
        metadata: {
          account_id: 'acc-subscriber',
          type: 'subscription',
          monthly_usd: 50,
          tier_key: 'credits',
        },
      },
    });

    const res = await processPaystackWebhook(payload, sign(payload));
    expect(res.received).toBe(true);
    expect(mockWalletGrants.length).toBe(1);
    expect(mockWalletGrants[0]).toMatchObject({
      accountId: 'acc-subscriber',
      amount: 50,
      kind: 'tier_grant',
    });
    expect(mockStripeSyncs.length).toBe(1);
    expect(mockStripeSyncs[0]).toMatchObject({
      accountId: 'acc-subscriber',
      patch: {
        tier: 'credits',
        provider: 'paystack',
        paymentStatus: 'active',
        planMonthlyUsd: '50',
      },
    });
  });

  test('handles charge.success for one-off purchase: grants purchase credits', async () => {
    mockPurchases.push({
      id: 'pur_123',
      accountId: 'acc-buyer',
      amountDollars: '25',
      status: 'pending',
      paystackReference: 'psk_pur_123',
    });

    const payload = JSON.stringify({
      event: 'charge.success',
      data: {
        status: 'success',
        reference: 'psk_pur_123',
        currency: 'NGN',
        amount: 4000000, // 40,000 NGN = $25
        metadata: {
          account_id: 'acc-buyer',
          type: 'credit_purchase',
        },
      },
    });

    const res = await processPaystackWebhook(payload, sign(payload));
    expect(res.received).toBe(true);
    expect(mockWalletGrants.length).toBe(1);
    expect(mockWalletGrants[0]).toMatchObject({
      accountId: 'acc-buyer',
      amount: 25,
      kind: 'purchase',
    });
    expect(mockPurchases[0].status).toBe('completed');
  });
});
