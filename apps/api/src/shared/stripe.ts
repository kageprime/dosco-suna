import Stripe from 'stripe';
import { BillingError } from '../errors';
import { config } from '../config';

let client: Stripe | null = null;

/** True when the deployment can talk to Stripe at all. */
export function stripeConfigured(): boolean {
  return Boolean(config.STRIPE_SECRET_KEY);
}

/**
 * Guard for Stripe-only billing paths. Billing boots with Stripe OR Paystack
 * (see config.ts), so Stripe paths must fail with a clear 400 — never a 500 —
 * on a Paystack-only deployment.
 */
export function requireStripe(): void {
  if (!config.STRIPE_SECRET_KEY) {
    throw new BillingError('Stripe is not configured on this deployment');
  }
}

export function getStripe(): Stripe {
  if (!client) {
    requireStripe();

    client = new Stripe(config.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
  }

  return client;
}
