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
 * Money: Paystack amounts are integer SUBUNITS of the currency. USD subunit is
 * the cent, so `toKobo(amountUsd)` is cents — the name is historical.
 */
import { config } from '../config';

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

/** USD → Paystack subunits (cents for USD charges). */
export function toSubunits(amountUsd: number): number {
  return Math.round(amountUsd * 100);
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
  amountUsd: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  planCode?: string;
}): Promise<PaystackInitTransaction> {
  return paystackFetch<PaystackInitTransaction>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: params.email,
      currency: 'USD',
      // With a plan_code Paystack uses the plan's amount; the explicit amount
      // is ignored — pass both only when there is no plan.
      ...(params.planCode
        ? { plan: params.planCode }
        : { amount: toSubunits(params.amountUsd) }),
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
  amountUsd: number;
  interval?: 'monthly' | 'annually';
  description?: string;
}): Promise<PaystackPlan> {
  return paystackFetch<PaystackPlan>('/plan', {
    method: 'POST',
    body: JSON.stringify({
      name: params.name,
      amount: toSubunits(params.amountUsd),
      interval: params.interval ?? 'monthly',
      currency: 'USD',
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
