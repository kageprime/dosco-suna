/**
 * Minimal Paystack REST client — raw `fetch`, no SDK dependency (mirrors the
 * house style: the API already talks to providers through thin wrappers).
 *
 * Configuration (all optional — billing routes degrade to a clear error when
 * the secret is missing):
 *   PAYSTACK_SECRET_KEY   server key (sk_…). Also the webhook HMAC key unless
 *                         PAYSTACK_WEBHOOK_SECRET overrides it.
 *   PAYSTACK_PUBLIC_KEY   client key (pk_…) — exposed via account-state for
 *                         inline checkout integrations.
 *   PAYSTACK_API_URL      defaults to https://api.paystack.co.
 *
 * Money: Paystack amounts are integer SUBUNITS of the charge currency.
 * This deployment bills in NGN (the merchant account cannot transact in
 * USD), so subunits are kobo. `toSubunits` works for any 2-decimal currency;
 * the USD→NGN conversion itself lives in billing/services/paystack.ts, next
 * to the rate config it depends on.
 */
import { config } from '../config';

/** The only currency this deployment charges on Paystack. */
export const PAYSTACK_CHARGE_CURRENCY = 'NGN' as const;

export interface PaystackInitTransaction {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackPlan {
  plan_code: string;
  name: string;
  amount: number;
  currency: string;
  interval: string;
}

export interface PaystackTransaction {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paid_at?: string;
  authorization?: { authorization_code?: string; last4?: string; bank?: string };
  customer?: { customer_code?: string; email?: string };
  metadata?: Record<string, unknown>;
}

export interface PaystackSubscription {
  subscription_code: string;
  email_token: string;
  status: string;
  next_payment_date?: string | null;
  amount: number;
  plan?: { plan_code?: string } | string;
  customer?: { customer_code?: string; email?: string };
}

export function paystackConfigured(): boolean {
  return Boolean(config.PAYSTACK_SECRET_KEY);
}

/** Major units → Paystack subunits (×100: naira→kobo, dollars→cents). */
export function toSubunits(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

/**
 * USD → whole NGN at the given rate (naira per 1 USD). Whole naira only:
 * kobo dust from FX math is rounded, never truncated — truncation would
 * systematically undercharge by up to ₦1 per transaction.
 */
export function usdToNgn(amountUsd: number, usdNgnRate: number): number {
  return Math.round(amountUsd * usdNgnRate);
}

/**
 * NGN kobo (Paystack `data.amount`) → USD dollars at the given rate, rounded
 * to the cent for the USD-denominated credit ledger. Inverts `usdToNgn`
 * within a cent for any sane rate (round-trip error < half a kobo).
 */
export function ngnSubunitsToUsd(amountKobo: number, usdNgnRate: number): number {
  return Math.round((amountKobo / 100 / usdNgnRate) * 100) / 100;
}

export function paystackWebhookKey(): string {
  return config.PAYSTACK_WEBHOOK_SECRET || config.PAYSTACK_SECRET_KEY || '';
}

async function paystackFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config.PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY not configured');
  }
  const res = await fetch(`${config.PAYSTACK_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as
    | { status?: boolean; message?: string; data?: T }
    | null;
  if (!res.ok || !body?.status) {
    const message = body?.message ?? `HTTP ${res.status}`;
    throw new Error(`[Paystack] ${init?.method ?? 'GET'} ${path}: ${message}`);
  }
  return body.data as T;
}

/** Hosted checkout: returns the authorization_url the browser redirects to. */
export function initializeTransaction(params: {
  email: string;
  amountSubunits: number;
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  planCode?: string;
}): Promise<PaystackInitTransaction> {
  return paystackFetch<PaystackInitTransaction>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: params.email,
      currency: params.currency,
      // With a plan_code Paystack uses the plan's amount; the explicit amount
      // is ignored — pass both only when there is no plan.
      ...(params.planCode
        ? { plan: params.planCode }
        : { amount: params.amountSubunits }),
      reference: params.reference,
      ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    }),
  });
}

export function verifyTransaction(reference: string): Promise<PaystackTransaction> {
  return paystackFetch<PaystackTransaction>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
}

export function fetchTransactionByReference(reference: string): Promise<PaystackTransaction> {
  return paystackFetch<PaystackTransaction>(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
}

export function createCustomer(params: { email: string }): Promise<{ customer_code: string }> {
  return paystackFetch<{ customer_code: string }>('/customer', {
    method: 'POST',
    body: JSON.stringify({ email: params.email }),
  });
}

export async function listPlans(search?: string): Promise<PaystackPlan[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : '';
  const data = await paystackFetch<PaystackPlan[]>(`/plan${query}`);
  return Array.isArray(data) ? data : [];
}

export function createPlan(params: {
  name: string;
  amountSubunits: number;
  currency: string;
  interval?: 'monthly' | 'annually';
  description?: string;
}): Promise<PaystackPlan> {
  return paystackFetch<PaystackPlan>('/plan', {
    method: 'POST',
    body: JSON.stringify({
      name: params.name,
      amount: params.amountSubunits,
      interval: params.interval ?? 'monthly',
      currency: params.currency,
      ...(params.description ? { description: params.description } : {}),
    }),
  });
}

export function fetchSubscription(code: string): Promise<PaystackSubscription> {
  return paystackFetch<PaystackSubscription>(`/subscription/${encodeURIComponent(code)}`);
}

export function fetchPlan(planCode: string): Promise<PaystackPlan> {
  return paystackFetch<PaystackPlan>(`/plan/${encodeURIComponent(planCode)}`);
}

export function disableSubscription(params: { code: string; token: string }): Promise<unknown> {
  return paystackFetch('/subscription/disable', {
    method: 'POST',
    body: JSON.stringify({ code: params.code, token: params.token }),
  });
}

export function enableSubscription(params: { code: string; token: string }): Promise<unknown> {
  return paystackFetch('/subscription/enable', {
    method: 'POST',
    body: JSON.stringify({ code: params.code, token: params.token }),
  });
}
