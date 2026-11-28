/**
 * Wallet grants for PAID mid-period plan changes.
 *
 * Raising the monthly amount mid-period is billed by a proration invoice
 * (`billing_reason: 'subscription_update'`). The credits that raise buys are
 * granted here, and only from a PAID invoice: a subscription update is a
 * promise to pay, not a payment. Each proration line converts at its own
 * plan's rate (`planCreditsUsd`, the volume bonus), so the grant is exactly the
 * remaining share of (new plan's credits − old plan's credits): a raise late in
 * the period buys a proportionally smaller grant, and the next renewal grants
 * the full new amount. A lowered amount bills no proration and grants nothing.
 *
 * Every grant is keyed on the invoice id (`proration_grant:<invoice id>`), so a
 * redelivered `invoice.paid` converges on one ledger row.
 */

import type Stripe from 'stripe';
import { getStripe } from '../../shared/stripe';
import { wallet } from '../wallet';
import { monthlyUsdForSubscription, planCreditsUsd } from './tiers';

/** The fields of an invoice line the grant rule reads. */
export interface ProrationLine {
  /** Line amount in cents. Negative for the unused-time credit. */
  amount: number;
  proration: boolean;
  /** The plan line's price and quantity, which decide its credits-per-dollar rate. */
  price?: Pick<Stripe.Price, 'id' | 'unit_amount' | 'recurring'> | null;
  quantity?: number | null;
}

export type ProrationGrant =
  | { kind: 'raise'; credits: number; netCents: number }
  | { kind: 'none'; reason: string };

/** Credits (USD) per dollar the plan on this line grants: 1 plus its volume bonus. */
function creditsPerDollar(line: ProrationLine): number {
  if (!line.price) return 1;
  const monthlyUsd = monthlyUsdForSubscription({ items: { data: [{ price: line.price, quantity: line.quantity ?? 1 }] } });
  return monthlyUsd > 0 ? planCreditsUsd(monthlyUsd) / monthlyUsd : 1;
}

/** Decide the grant for one paid proration invoice. Pure. */
export function computeProrationGrant(lines: ProrationLine[]): ProrationGrant {
  const prorations = lines.filter((line) => line.proration);
  if (prorations.length === 0) return { kind: 'none', reason: 'no proration lines' };
  const netCents = prorations.reduce((sum, line) => sum + line.amount, 0);
  if (netCents <= 0) return { kind: 'none', reason: 'change collected no money' };
  const creditCents = prorations.reduce((sum, line) => sum + line.amount * creditsPerDollar(line), 0);
  const credits = Math.round(creditCents) / 100;
  if (credits <= 0) return { kind: 'none', reason: 'change bought no credits' };
  return { kind: 'raise', netCents, credits };
}

async function invoiceLines(invoice: Stripe.Invoice): Promise<ProrationLine[]> {
  let raw: Stripe.InvoiceLineItem[] = invoice.lines?.data ?? [];
  if (invoice.lines?.has_more && invoice.id) {
    raw = await getStripe().invoices.listLineItems(invoice.id, { limit: 100 }).autoPagingToArray({ limit: 1000 });
  }
  return raw.map((line) => ({
    amount: line.amount ?? 0,
    proration: line.proration === true,
    price: line.price ?? null,
    quantity: line.quantity ?? null,
  }));
}

/**
 * Grant the allowance a PAID proration invoice bought. Returns the decision so
 * callers can log or report it. Throws only when the grant itself fails, which
 * fails the webhook and makes Stripe redeliver it.
 */
export async function grantForPaidProrationInvoice(
  accountId: string,
  invoice: Stripe.Invoice,
): Promise<ProrationGrant> {
  if (invoice.status !== 'paid') {
    return { kind: 'none', reason: `invoice status ${invoice.status ?? 'unknown'}` };
  }

  const decision = computeProrationGrant(await invoiceLines(invoice));
  if (decision.kind === 'none' || decision.credits <= 0) {
    console.log(`[proration-grant] ${accountId} invoice ${invoice.id}: no grant (${decision.kind === 'none' ? decision.reason : 'zero credits'})`);
    return decision;
  }

  const description = `Plan raised: ${Math.round(decision.credits * 100)} credits (prorated $${(decision.netCents / 100).toFixed(2)} charge)`;

  await wallet.grant({
    accountId,
    amount: decision.credits,
    kind: 'tier_grant',
    description,
    expiring: true,
    key: { event: `proration_grant:${invoice.id}` },
  });
  console.log(`[proration-grant] ${accountId} invoice ${invoice.id}: ${description}`);
  return decision;
}
