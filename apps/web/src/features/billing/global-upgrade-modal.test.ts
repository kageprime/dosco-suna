import { describe, expect, test } from 'bun:test';

import { billingModalNeedsTopUp } from '@kortix/ui/internal/lib/billing/billing-gate-state';

import { billingModalLayout } from './global-upgrade-modal';

// Paper "Out of credits — v3" (2026-11-10): any account that cannot run opens
// the compact modal, one slider and one action. Which slider (monthly plan or
// one-off) is decided inside it, from `canOfferTopup`.
describe('billingModalLayout', () => {
  test('out of credits or payment failed: the compact modal, with or without a plan', () => {
    expect(billingModalLayout({ needsTopUp: true, hasSubscription: true })).toBe('topup-first');
    expect(billingModalLayout({ needsTopUp: true, hasSubscription: false })).toBe('topup-first');
  });

  test('an account that pays and is not blocked: the plan leads', () => {
    expect(billingModalLayout({ needsTopUp: false, hasSubscription: true })).toBe('plan-first');
  });

  test('a voluntary visit without a plan: Free against Credits', () => {
    expect(billingModalLayout({ needsTopUp: false, hasSubscription: false })).toBe('plans');
  });
});

// Review finding 10: a Free workspace below the run floor opened on the plans
// view, whose only ways out were "Continue on Free" and a subscription. It now
// opens the compact modal, whether or not the account may buy one-off credits.
describe('a 0-credit Free workspace opens the compact modal', () => {
  const freeWorkspace = (total: number, canPurchase = false) => ({
    billing_state: 'no_subscription' as const,
    has_active_subscription: false,
    credits: { total, can_run: total >= 0.01 },
    tier: { can_purchase_credits: canPurchase, monthly_credits: 0 },
  });

  test('0 credits on Free, without one-off top-ups (the default since 2026-11-09)', () => {
    const state = freeWorkspace(0);
    expect(
      billingModalLayout({
        needsTopUp: billingModalNeedsTopUp(state, 'no_subscription'),
        hasSubscription: false,
      }),
    ).toBe('topup-first');
  });

  test('0 credits on Free with the one-off grant', () => {
    expect(billingModalNeedsTopUp(freeWorkspace(0, true), 'no_subscription')).toBe(true);
  });

  test('a funded Free workspace keeps the plans view', () => {
    expect(billingModalNeedsTopUp(freeWorkspace(5), 'no_subscription')).toBe(false);
  });

  test('out of credits and payment failed still open the compact modal', () => {
    expect(billingModalNeedsTopUp(freeWorkspace(0), 'out_of_credits')).toBe(true);
    expect(billingModalNeedsTopUp(null, 'payment_failed')).toBe(true);
  });
});
