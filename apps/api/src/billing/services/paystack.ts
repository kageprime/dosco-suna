/**
 * Paystack billing service — the Nigerian-market counterpart of the Stripe
 * flow in `subscriptions.ts` / `webhooks.ts`.
 *
 * Shape of the integration:
 *  - One-off credit purchases: `transaction/initialize` with our own
 *    reference (`psk_<purchase_id>`); the browser redirects to
 *    `authorization_url`; the `charge.success` webhook settles the pending
 *    purchase row and grants credits.
 *  - Recurring plans: a Paystack plan is ensured per (tier, seat count) at
 *    checkout (`dosco_<tier>` / `dosco_<tier>_<n>seats`), the transaction is
 *    initialized against that plan, and the first `charge.success` activates
 *    the tier. `subscription.create` stores the subscription code + email
 *    token; `subscription.disable` downgrades to free. Renewals re-fire
 *    `charge.success` and re-grant the plan's included credits (deduped by
 *    charge reference).
 *
 * Money moves first, entitlements second: every activation here is triggered
 * by a signature-verified `charge.success`, which is Paystack's settled-
 * payment event (the analogue of Stripe's `invoice.paid`, not
 * `checkout.session.completed`).
 *
 * Billing currency is NGN (the merchant account cannot transact in USD):
 * USD-denominated prices convert at PAYSTACK_USD_NGN_RATE, whole naira.
 * The credit ledger stays USD; webhooks convert settled kobo back to USD
 * at the same rate before granting.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { BillingError } from '../../errors';
import { config } from '../../config';
import { db } from '../../shared/db';
import * as paystack from '../../shared/paystack';
import { billingCustomers, creditAccounts, creditPurchases } from '@kortix/db';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { insertPurchase, updatePurchaseStatus } from '../repositories/transactions';
import { upsertCustomer } from '../repositories/customers';
import { applyStripeSync } from './account-write-owner';
import { grantCredits } from './credits';
import { resolvePlanRecord } from './plan-catalog';

export function paystackEnabled(): boolean {
  return paystack.paystackConfigured();
}

function requirePaystack(): void {
  if (!paystack.paystackConfigured()) {
    throw new BillingError('Paystack is not configured on this deployment');
  }
}

/**
 * Naira per 1 USD for Paystack CHECKOUT. Missing/zero → clear 400: never
 * boot-blocking, and never a guessed charge — a wrong rate is real money.
 */
function checkoutUsdNgnRate(): number {
  const rate = Number(config.PAYSTACK_USD_NGN_RATE ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new BillingError(
      'Paystack NGN rate (PAYSTACK_USD_NGN_RATE) is not configured on this deployment',
    );
  }
  return rate;
}

/**
 * Same rate for the WEBHOOK path — but a missing rate here must stay a 500
 * (plain Error), so Paystack retries delivery after the operator sets the
 * rate. A 400 would acknowledge-and-drop a settled, already-paid charge.
 */
function webhookUsdNgnRate(): number {
  const rate = Number(config.PAYSTACK_USD_NGN_RATE ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('PAYSTACK_USD_NGN_RATE is not configured; cannot settle Paystack charge');
  }
  return rate;
}

/**
 * User-facing checkout calls must fail with a readable 400, never an opaque
 * 500. Paystack rejects at the provider level (unknown customer, unsupported
 * currency, closed account) and the buyer can only act on the real reason —
 * e.g. "Currency not supported by merchant" tells the operator the merchant
 * account needs USD enabled, where "Internal server error" tells nothing.
 * Webhook handlers deliberately do NOT use this: a transient Paystack outage
 * there should stay a 500 so Paystack retries delivery.
 */
async function paystackCheckout<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingError) throw err;
    throw new BillingError(`Paystack ${label} failed: ${(err as Error).message}`);
  }
}

// ─── Customers ──────────────────────────────────────────────────────────────

export async function getOrCreatePaystackCustomer(
  accountId: string,
  email: string,
): Promise<string> {
  const rows = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.accountId, accountId));
  const existing = rows.find((r) => (r.provider ?? 'stripe') === 'paystack' && r.active !== false);
  if (existing) return existing.id;

  const customer = await paystack.createCustomer({ email });
  await upsertCustomer({
    accountId,
    id: customer.customer_code,
    email,
    provider: 'paystack',
    active: true,
  });
  return customer.customer_code;
}

async function getAccountIdByPaystackCustomerCode(customerCode: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.id, customerCode))
    .limit(1);
  const hit = rows.find((r) => (r.provider ?? 'stripe') === 'paystack');
  return hit?.accountId ?? null;
}

async function getAccountIdByPaystackSubscriptionCode(code: string): Promise<string | null> {
  const rows = await db
    .select({ accountId: creditAccounts.accountId })
    .from(creditAccounts)
    .where(eq(creditAccounts.paystackSubscriptionCode, code))
    .limit(1);
  return rows[0]?.accountId ?? null;
}

// ─── Credit purchases (one-off) ─────────────────────────────────────────────

export async function createPaystackCreditCheckout(params: {
  accountId: string;
  email: string;
  amount: number;
  successUrl?: string;
}): Promise<{ checkout_url: string; reference: string }> {
  requirePaystack();
  const rate = checkoutUsdNgnRate();
  const amountNgn = paystack.usdToNgn(params.amount, rate);

  const purchase = await insertPurchase({
    accountId: params.accountId,
    amountDollars: String(params.amount),
    status: 'pending',
    description: `$${params.amount} credit purchase`,
    provider: 'paystack',
    metadata: {
      paystack_currency: paystack.PAYSTACK_CHARGE_CURRENCY,
      paystack_amount_ngn: amountNgn,
      usd_ngn_rate: rate,
    },
  });

  const reference = `psk_${purchase!.id}`;
  const init = await paystackCheckout('credit checkout', async () => {
    const customerId = await getOrCreatePaystackCustomer(params.accountId, params.email);
    return paystack.initializeTransaction({
      email: params.email,
      amountSubunits: paystack.toSubunits(amountNgn),
      currency: paystack.PAYSTACK_CHARGE_CURRENCY,
      reference,
      callbackUrl: params.successUrl,
      metadata: {
        account_id: params.accountId,
        purchase_id: purchase!.id,
        type: 'credit_purchase',
        paystack_customer: customerId,
      },
    });
  });

  await db
    .update(creditPurchases)
    .set({ paystackReference: init.reference, paystackAccessCode: init.access_code })
    .where(eq(creditPurchases.id, purchase!.id));

  return { checkout_url: init.authorization_url, reference: init.reference };
}

// ─── Subscriptions (recurring) ──────────────────────────────────────────────

/** Plan names are deterministic so repeat checkouts reuse the same plan. */
function paystackPlanName(tierKey: string, seats?: number): string {
  if (seats && seats > 1) return `dosco_${tierKey}_${seats}seats`;
  return `dosco_${tierKey}`;
}

/** `dosco_<tier>` / `dosco_<tier>_<n>seats` → tier key. */
async function tierKeyFromPaystackPlan(planCode: string): Promise<string | null> {
  try {
    const plan = await paystack.fetchPlan(planCode);
    const name: string = plan?.name ?? '';
    if (!name.startsWith('dosco_')) return null;
    const tier = name.slice('dosco_'.length).replace(/_\d+seats$/, '');
    return tier || null;
  } catch (err) {
    console.warn(`[Paystack] could not resolve plan ${planCode}:`, err);
    return null;
  }
}

async function ensurePaystackPlan(
  tierKey: string,
  seats?: number,
): Promise<{ planCode: string; amountNgn: number }> {
  const plan = resolvePlanRecord(tierKey);
  const seatsMultiplier = plan.price.unit === 'seat_month' ? Math.max(1, seats ?? 1) : 1;
  const amountUsd = plan.price.amountUsd * seatsMultiplier;
  if (amountUsd <= 0) throw new BillingError('This plan does not require payment');

  // USD-denominated catalog price → whole naira at the configured rate.
  const rate = checkoutUsdNgnRate();
  const amountNgn = paystack.usdToNgn(amountUsd, rate);

  const name = paystackPlanName(tierKey, seats);
  const plans = await paystack.listPlans(name);
  const hit = plans.find((p) => p.name === name && p.currency === paystack.PAYSTACK_CHARGE_CURRENCY);
  if (hit) return { planCode: hit.plan_code, amountNgn };

  const created = await paystack.createPlan({
    name,
    amountSubunits: paystack.toSubunits(amountNgn),
    currency: paystack.PAYSTACK_CHARGE_CURRENCY,
    interval: 'monthly',
    description: `Dosco ${tierKey} plan${seatsMultiplier > 1 ? ` (${seatsMultiplier} seats)` : ''}`,
  });
  return { planCode: created.plan_code, amountNgn };
}

export async function createPaystackSubscriptionCheckout(params: {
  accountId: string;
  email: string;
  tierKey: string;
  successUrl?: string;
  seats?: number;
}): Promise<{ checkout_url: string; reference: string }> {
  requirePaystack();

  const { init } = await paystackCheckout('subscription checkout', async () => {
    const { planCode, amountNgn } = await ensurePaystackPlan(params.tierKey, params.seats);
    const customerId = await getOrCreatePaystackCustomer(params.accountId, params.email);

    const reference = `psk_sub_${randomUUID()}`;
    const init = await paystack.initializeTransaction({
      email: params.email,
      amountSubunits: paystack.toSubunits(amountNgn),
      currency: paystack.PAYSTACK_CHARGE_CURRENCY,
      reference,
      callbackUrl: params.successUrl,
      planCode,
      metadata: {
        account_id: params.accountId,
        tier_key: params.tierKey,
        plan_key: params.tierKey,
        type: 'subscription',
        seats: params.seats ?? null,
        paystack_customer: customerId,
      },
    });
    return { init };
  });

  return { checkout_url: init.authorization_url, reference: init.reference };
}

/** Cancel at period end — Paystack stops renewals; the tier lapses on the
 *  `subscription.disable` webhook, mirroring Stripe's cancelled-at-period-end. */
export async function cancelPaystackSubscription(accountId: string): Promise<{ ok: boolean }> {
  const account = await getCreditAccount(accountId);
  const code = account?.paystackSubscriptionCode;
  if (!code || !account?.paystackEmailToken) {
    throw new BillingError('Account has no Paystack subscription to cancel');
  }
  // Captured to a const: property narrowing does not survive into the
  // closure below, and the guard above already proved it non-null.
  const token = account.paystackEmailToken;
  await paystackCheckout('cancel subscription', () =>
    paystack.disableSubscription({ code, token }),
  );
  return { ok: true };
}

// ─── Webhook processing ─────────────────────────────────────────────────────

/** HMAC-SHA512 over the raw body — Paystack's documented signature scheme. */
export function verifyPaystackSignature(rawBody: string, signature: string | undefined): boolean {
  const key = paystack.paystackWebhookKey();
  if (!key || !signature) return false;
  const expected = createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseMetadata(data: Record<string, any>): Record<string, any> {
  const meta = data?.metadata;
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch {
      return {};
    }
  }
  return meta;
}

/** Tier activation + included-credit grant for a SETTLED plan charge. */
async function activatePaystackSubscription(
  accountId: string,
  tierKey: string,
  reference: string,
): Promise<void> {
  const plan = resolvePlanRecord(tierKey);
  if (plan.grant.includedCreditsUsd > 0) {
    await grantCredits(
      accountId,
      plan.grant.includedCreditsUsd,
      'purchase',
      `${tierKey} plan credits (Paystack)`,
      false,
      undefined,
      { idempotencyKey: `paystack:${reference}` },
    );
  }
  await applyStripeSync(
    accountId,
    { tier: tierKey, provider: 'paystack', paymentStatus: 'active' },
    { reason: 'paystack:charge.success' },
  );
}

async function handleChargeSuccess(data: Record<string, any>): Promise<void> {
  const reference: string | undefined = data?.reference;
  if (!reference || data?.status !== 'success') return;

  // This deployment charges NGN only. Anything else is a misrouted or legacy
  // charge — refuse rather than convert under a wrong assumption.
  const currency = String(data.currency ?? '').toUpperCase();
  if (currency !== paystack.PAYSTACK_CHARGE_CURRENCY) {
    console.warn(
      `[Paystack] charge.success ${reference}: unsupported currency ${currency || '(missing)'} — refusing to grant`,
    );
    return;
  }
  const rate = webhookUsdNgnRate();
  const amountNgn = Number(data.amount ?? 0) / 100;
  // Kobo → naira → USD at the configured rate, rounded to the cent for the
  // USD-denominated ledger.
  const amountUsd = paystack.ngnSubunitsToUsd(Number(data.amount ?? 0), rate);
  const metadata = parseMetadata(data);
  const type = String(metadata.type ?? '');

  // ── One-off credit purchase ──
  const purchaseRows = await db
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.paystackReference, reference))
    .limit(1);
  const purchaseRow = purchaseRows[0] ?? null;

  if (purchaseRow) {
    if (purchaseRow.status === 'completed') {
      console.log(`[Paystack] Duplicate charge.success for ${reference} — deduped`);
      return;
    }
    // Amount guard: the settled charge must match the pending purchase.
    // Converted back at the same rate, so anything beyond a cent of
    // rounding drift means underpayment.
    const expected = Number(purchaseRow.amountDollars);
    if (amountUsd + 0.01 < expected) {
      console.error(
        `[Paystack] charge.success ${reference}: amount mismatch (got $${amountUsd} / ₦${amountNgn} at ${rate}, expected $${expected}) — refusing to grant`,
      );
      return;
    }
    await grantCredits(
      purchaseRow.accountId,
      amountUsd,
      'purchase',
      `Credit purchase: $${amountUsd.toFixed(2)} (Paystack ₦${amountNgn})`,
      false,
      undefined,
      { idempotencyKey: `paystack:${reference}` },
    );
    await updatePurchaseStatus(purchaseRow.id, 'completed', new Date().toISOString());
    console.log(`[Paystack] Credit purchase: $${amountUsd} (₦${amountNgn}) for ${purchaseRow.accountId}`);
    return;
  }

  // ── Subscription charge (first payment OR renewal) ──
  const accountId: string | undefined = metadata.account_id;
  const tierKey: string | undefined = metadata.tier_key ?? metadata.plan_key;
  if (type === 'subscription' && accountId && tierKey) {
    await activatePaystackSubscription(accountId, tierKey, reference);
    console.log(`[Paystack] Subscription charge settled for ${accountId} (${tierKey})`);
    return;
  }

  // Renewals don't carry our original checkout metadata — resolve the account
  // through the subscription / paystack customer, and the tier through the
  // plan's deterministic name.
  const subCode: string | undefined = data.subscription?.subscription_code;
  const planCode: string | undefined = data.plan?.plan_code ?? data.plan_object?.plan_code;
  let renewalAccount = subCode ? await getAccountIdByPaystackSubscriptionCode(subCode) : null;
  if (!renewalAccount && data.customer?.customer_code) {
    renewalAccount = await getAccountIdByPaystackCustomerCode(data.customer.customer_code);
  }
  if (renewalAccount && planCode) {
    const renewalTier = await tierKeyFromPaystackPlan(planCode);
    if (renewalTier) {
      await activatePaystackSubscription(renewalAccount, renewalTier, reference);
      console.log(`[Paystack] Renewal settled for ${renewalAccount} (${renewalTier})`);
      return;
    }
  }

  console.warn(`[Paystack] charge.success ${reference}: no matching purchase or subscription`);
}

async function handleSubscriptionCreated(data: Record<string, any>): Promise<void> {
  const code = data?.subscription_code;
  if (!code) return;
  const customerCode: string | undefined = data?.customer?.customer_code;
  const accountId = customerCode ? await getAccountIdByPaystackCustomerCode(customerCode) : null;
  if (!accountId) {
    console.warn(`[Paystack] subscription.create ${code}: unknown customer, cannot attach`);
    return;
  }
  await updateCreditAccount(accountId, {
    paystackSubscriptionCode: code,
    paystackEmailToken: data.email_token ?? null,
    provider: 'paystack',
  });
  console.log(`[Paystack] subscription ${code} attached to ${accountId}`);
}

async function handleSubscriptionDisabled(data: Record<string, any>): Promise<void> {
  const code = data?.subscription_code;
  if (!code) return;
  const accountId = await getAccountIdByPaystackSubscriptionCode(code);
  if (!accountId) {
    console.warn(`[Paystack] subscription.disable ${code}: unknown subscription`);
    return;
  }
  await applyStripeSync(
    accountId,
    { tier: 'free', provider: 'paystack', paymentStatus: 'active' },
    { reason: 'paystack:subscription.disable' },
  );
  console.log(`[Paystack] subscription ${code} disabled — ${accountId} downgraded to free`);
}

export async function processPaystackWebhook(
  rawBody: string,
  signature: string | undefined,
): Promise<{ received: boolean; event?: string }> {
  if (!verifyPaystackSignature(rawBody, signature)) {
    throw new BillingError('Invalid Paystack signature');
  }

  let event: { event?: string; data?: Record<string, any> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new BillingError('Invalid Paystack webhook payload');
  }

  switch (event.event) {
    case 'charge.success':
      await handleChargeSuccess(event.data ?? {});
      break;
    case 'subscription.create':
      await handleSubscriptionCreated(event.data ?? {});
      break;
    case 'subscription.disable':
    case 'subscription.not_renew':
      await handleSubscriptionDisabled(event.data ?? {});
      break;
    default:
      console.log(`[Paystack] Unhandled webhook event: ${event.event}`);
  }

  return { received: true, event: event.event };
}
