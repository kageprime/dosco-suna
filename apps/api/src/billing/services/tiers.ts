import type Stripe from 'stripe';
import { config } from '../../config';
import type { TierConfig, TierEntitlements } from '../../types';
import { canonicalTier } from './tier-facts';

// Config-free tier facts live in their own module so genuinely pure consumers
// (billing-state.ts) can import them without booting env validation. Re-exported
// here so every `from './tiers'` import keeps working — one definition.
export {
  LEGACY_PAID_PLAN_KEYS,
  MINIMUM_CREDIT_FOR_RUN,
  PLAN_KEYS,
  canonicalTier,
  isPaidTier,
  type PlanKey,
} from './tier-facts';

/**
 * The platform fee on Kortix-managed model usage, as a percent of the
 * provider's base price. Customers see base prices; the fee is stated once.
 * 5.5% matches what the upstream router charges on credit purchases, so
 * managed models run at break-even until routes move to direct providers.
 * BYOK usage is free up to a monthly allowance, then carries its own fee
 * (byok-fee.ts); ChatGPT-subscription usage costs no credits.
 */
export const LLM_PLATFORM_FEE_PERCENT = 5.5;

/**
 * Multiplier applied to the provider cost on every managed LLM gateway call:
 * base × (1 + fee). Override per environment with KORTIX_LLM_MARKUP (1.0 =
 * at cost). Clamped to >= 1 so we never undercut the provider.
 */
const DEFAULT_LLM_PRICE_MARKUP = 1 + LLM_PLATFORM_FEE_PERCENT / 100;

export function llmPriceMarkup(): number {
  const raw = Number.parseFloat(process.env.KORTIX_LLM_MARKUP ?? '');
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LLM_PRICE_MARKUP;
  return raw;
}

// ─── Credits-only billing ────────────────────────────────────────────────────
// One credit = $0.01. A paid account picks any monthly amount; every member
// spends from one shared wallet; plans differ only in credit volume. Free gets
// $5 (500 credits) a month and every self-serve feature. See tier-facts.ts for
// the legacy plan keys.

/** Smallest and largest self-serve monthly amount, in whole dollars. */
export const PLAN_MIN_MONTHLY_USD = 50;
export const PLAN_MAX_MONTHLY_USD = 50_000;

/**
 * The tier ladder the product offers: named monthly amounts of the one credits
 * plan, same rate at every step. `popular` marks the most common paid amount
 * at or above the minimum. The API accepts any whole amount in range; the
 * ladder is what the UI sells.
 */
export const PLAN_PRESETS = [
  { monthlyUsd: 50 },
  { monthlyUsd: 75 },
  { monthlyUsd: 100 },
  { monthlyUsd: 200, popular: true },
  { monthlyUsd: 300 },
  { monthlyUsd: 400 },
  { monthlyUsd: 500 },
  { monthlyUsd: 750 },
  { monthlyUsd: 1_000 },
  { monthlyUsd: 1_500 },
  { monthlyUsd: 2_000 },
  { monthlyUsd: 3_000 },
  { monthlyUsd: 4_000 },
  { monthlyUsd: 5_000 },
  { monthlyUsd: 7_500 },
  { monthlyUsd: 10_000 },
  { monthlyUsd: 12_500 },
  { monthlyUsd: 15_000 },
  { monthlyUsd: 20_000 },
  { monthlyUsd: 25_000 },
  { monthlyUsd: 30_000 },
  { monthlyUsd: 35_000 },
  { monthlyUsd: 40_000 },
  { monthlyUsd: 45_000 },
  { monthlyUsd: 50_000 },
] as const;

/**
 * Top-up bonus: a one-time or auto top-up adds a few percent of extra credits,
 * a little more at each step, flat from $1,000. Bonus credits never expire,
 * like the top-up itself, and a refund or dispute takes them back with it.
 * Monthly plan tiers carry no bonus: 1 credit = $0.01 there, at every tier.
 */
export const TOP_UP_BONUS_STEPS = [
  { minUsd: 1_000, percent: 5 },
  { minUsd: 500, percent: 4 },
  { minUsd: 250, percent: 3 },
  { minUsd: 100, percent: 2 },
  { minUsd: 50, percent: 1 },
] as const;

/** Bonus credits (USD) a top-up of `amountUsd` adds. 0 below $50. */
export function topUpBonusUsd(amountUsd: number): number {
  const step = TOP_UP_BONUS_STEPS.find((s) => amountUsd >= s.minUsd);
  return step ? Math.round(amountUsd * step.percent) / 100 : 0;
}

export const MAX_PROJECTS_PER_ACCOUNT = 200;
<<<<<<< HEAD
export const MAX_CONCURRENT_SANDBOXES_PER_SEAT = 3;
export const MAX_SEATS_PER_ACCOUNT = 100;

export type BillingModel = 'legacy' | 'per_seat' | 'credit';

/** Default auto-topup for a per-seat account given its current seat count. */
export function defaultAutoTopupForSeats(seatCount: number): { threshold: number; amount: number } {
  const seats = Math.max(1, seatCount);
  return {
    threshold: AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT * seats,
    amount: AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT * seats,
  };
}

/**
 * Monthly wallet grant for N seats. INCLUDED_CREDITS_PER_SEAT_USD ($25) per
 * seat, fungible across compute and LLM usage — NOT the full $40 seat price
 * (the other $15 is platform margin). Per-category transparency comes from the
 * credit_ledger (compute_debit / llm_debit), not from a wallet partition.
 */
export function grantForSeats(seatCount: number): number {
  return INCLUDED_CREDITS_PER_SEAT_USD * Math.max(1, seatCount);
}

/**
 * Included-usage share of every subscription dollar: $25 of each $40 seat.
 * The one ratio the whole renewal-grant rule reduces to — see
 * `resolveRenewalGrant`.
 */
export const INCLUDED_CREDITS_RATIO = INCLUDED_CREDITS_PER_SEAT_USD / PER_SEAT_PRICE_USD;

/**
 * THE renewal-grant rule: what a paid subscription-cycle invoice puts in the
 * wallet. One resolver, resolved from the SUBSCRIPTION that was billed, in
 * precedence order:
 *
 *   1. Per-seat: seats × $25 — the seat count is the contract. (For the
 *      standard $40 seat price this equals amount × INCLUDED_CREDITS_RATIO
 *      exactly; the seat count stays authoritative for discounted invoices.)
 *   2. A tier with a configured monthly grant (v3 credit plans, free): that
 *      grant, unchanged.
 *   3. Everything else that PAID — the legacy zoo (machine subscriptions,
 *      legacy `pro`, retired tier_* keys with no grant): the money that
 *      actually moved × INCLUDED_CREDITS_RATIO. Before this rule those
 *      renewals granted 0: a $40/mo "Dosco Agent" customer paid every
 *      month, sat at a $0 wallet, and could not run anything. There is no
 *      per-key mapping table to maintain — the paid invoice IS the mapping.
 *
 * Pure — testable without Stripe or a DB.
 */
export function resolveRenewalGrant(args: {
  tierName: string;
  billingModel: string | null | undefined;
  seatCount: number | null | undefined;
  /** invoice.amount_paid, in USD (Stripe reports cents — divide by 100). */
  amountPaidUsd: number;
}): { credits: number; description: string } {
  if (args.tierName === 'per_seat' || isPerSeatAccount(args.billingModel)) {
    const seats = Math.max(1, args.seatCount ?? 1);
    const credits = grantForSeats(seats);
    return {
      credits,
      description: `Monthly renewal: ${credits} credits (${seats} ${seats === 1 ? 'seat' : 'seats'})`,
    };
  }
  const configured = getMonthlyCredits(args.tierName);
  if (configured > 0) {
    return { credits: configured, description: `Monthly renewal: ${configured} credits` };
  }
  const credits = Math.round(Math.max(0, args.amountPaidUsd) * INCLUDED_CREDITS_RATIO * 100) / 100;
  return {
    credits,
    description: `Monthly renewal: ${credits} credits (legacy subscription, $${args.amountPaidUsd} paid)`,
  };
}

// ─── Compute instance definitions ───────────────────────────────────────────
// Single source of truth for the machine tiers we sell.

interface ComputeTier {
  label: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  priceUsd: number;
}

export const COMPUTE_TIERS: Record<string, ComputeTier> = {
  pro: { label: 'Pro', cores: 8, memoryGb: 16, diskGb: 320, priceUsd: 40 },
  power: { label: 'Power', cores: 12, memoryGb: 24, diskGb: 480, priceUsd: 60 },
  ultra: { label: 'Ultra', cores: 16, memoryGb: 32, diskGb: 640, priceUsd: 80 },
};

/** Return the display price in USD cents for a server type, or null if unknown. */
export function getComputeDisplayPriceCents(serverType: string): number | null {
  const tier = COMPUTE_TIERS[serverType];
  return tier ? tier.priceUsd * 100 : null;
}

/**
 * Human-readable line for Stripe checkout / invoice descriptions.
 * Example: "Dosco Agent · Pro — 8 vCPU, 16 GB RAM, 320 GB SSD"
 */
export function getComputeDescription(serverType: string): string {
  const t = COMPUTE_TIERS[serverType];
  if (!t) return 'Dosco Agent';
  return `Dosco Agent · ${t.label} — ${t.cores} vCPU, ${t.memoryGb} GB RAM, ${t.diskGb} GB SSD`;
}
=======
>>>>>>> upstream-dev

// ─── Tiers ──────────────────────────────────────────────────────────────────

// Enterprise feature gates. The whole IAM surface — groups + custom
// roles/policies (`rbac`), the identity providers (SAML SSO + SCIM), and
// audit log access — is exclusive to the sales-assigned `enterprise` tier.
// Non-entitled accounts see an upsell in the UI and a 402 from the
// requireEntitlement() guard on create/update routes. See TierEntitlements.
const SELF_SERVE: TierEntitlements = {
  sso: false,
  scim: false,
  rbac: false,
  auditAccess: false,
  branding: false,
};
const ALL_ENTERPRISE: TierEntitlements = {
  sso: true,
  scim: true,
  rbac: true,
  auditAccess: true,
  branding: true,
};

/**
 * `monthlyCredits` is the FIXED allowance. `credits` has none: its allowance is
 * the account's chosen amount (`credit_accounts.plan_monthly_usd`), resolved
 * from the subscription by `monthlyCreditsForSubscription`.
 */
const TIERS: Record<string, TierConfig> = {
  none: {
    name: 'none',
    displayName: 'No Plan',
    monthlyCredits: 0,
    canPurchaseCredits: false,
    models: [],
    appLimit: 50,
    entitlements: SELF_SERVE,
  },

  free: {
    name: 'free',
    displayName: 'Free',
    monthlyCredits: 5,
    canPurchaseCredits: true,
    models: ['all'],
    appLimit: 50,
    entitlements: SELF_SERVE,
  },

<<<<<<< HEAD
  pro: {
    name: 'pro',
    displayName: 'Pro',
    monthlyPrice: 20,
    yearlyPrice: 0, // No yearly billing
    monthlyCredits: 0, // No monthly credits — $5 one-time per machine only
    canPurchaseCredits: true,
    models: ['all'],
    dailyCreditConfig: null,
    hidden: false,
    appLimit: 200,
    entitlements: SELF_SERVE,
  },

  // Billing v2 — per-member seat plan. $25 × seat_count / month.
  // The TIERS entry models a single seat; multi-seat math is in
  // grantForSeats() and applied at subscription create + renew.
  //
  // GRANDFATHERED (billing v3). Existing per-seat customers keep this tier
  // exactly as it is — same price, same $25/seat grant, same 200 Apps,
  // and `models: ['all']` so their managed-model access is NOT withdrawn under
  // them. It is `hidden` only so the self-serve grid stops offering it to new
  // customers; every existing subscription resolves it unchanged.
  per_seat: {
    name: 'per_seat',
    displayName: 'Team (legacy seats)',
    monthlyPrice: PER_SEAT_PRICE_USD,
    yearlyPrice: 0,
    monthlyCredits: INCLUDED_CREDITS_PER_SEAT_USD,
    canPurchaseCredits: true,
    models: ['all'],
    dailyCreditConfig: null,
    hidden: true,
    appLimit: 200,
    entitlements: SELF_SERVE,
  },

  // ── Billing v3 — flat credit plans ───────────────────────────────────────
  // The plan carries the credit pool and the concurrency limit; headcount does
  // not enter the price. Seats priced humans, but the cost driver is agents,
  // and agents run unattended — a team of two could run fifty of them, and a
  // Dosco-as-a-Backend customer serves end users who are not seats at all.
  //
  // `models: []` — NO included managed LLM. `tierGrantsAllModels` is false, so
  // the wallet funds sandbox compute only, exactly as the free tier already
  // works. BYOK, OpenCode and ChatGPT-subscription paths are untouched; a
  // managed key is billed against the wallet only for tiers that grant models.
  // This takes Dosco out of a short position on model prices: an upstream
  // increase can no longer eat a fixed plan's margin.
  //
  // Price : credits holds at 1.6 : 1, which is ~48% gross margin when a plan
  // burns its whole pool (COGS = pool ÷ KORTIX_MARKUP). Keep that ratio if you
  // add a tier — it is the number that makes the ladder coherent.
  starter: {
    name: 'starter',
    displayName: 'Starter',
    monthlyPrice: 40,
    yearlyPrice: 0,
    monthlyCredits: 25,
    canPurchaseCredits: true,
    models: [],
    dailyCreditConfig: null,
    hidden: false,
    appLimit: 3,
    entitlements: SELF_SERVE,
  },

  team: {
    name: 'team',
    displayName: 'Team',
    monthlyPrice: 200,
    yearlyPrice: 0,
    monthlyCredits: 125,
    canPurchaseCredits: true,
    models: [],
    dailyCreditConfig: null,
    hidden: false,
    appLimit: 10,
    entitlements: SELF_SERVE,
  },

  scale: {
    name: 'scale',
    displayName: 'Scale',
    monthlyPrice: 800,
    yearlyPrice: 0,
    monthlyCredits: 500,
    canPurchaseCredits: true,
    models: [],
    dailyCreditConfig: null,
    hidden: false,
    appLimit: 30,
    entitlements: SELF_SERVE,
  },

  // ── Enterprise (sales-assigned, not self-serve) ──────────────────────────
  // Custom / contact-sales. Not purchasable through normal checkout — an
  // operator sets credit_accounts.tier='enterprise' as part of the deal, and
  // credits are granted out-of-band per the contract. This is the ONLY tier
  // that unlocks the enterprise identity surfaces (SSO + SCIM). Hidden from the
  // self-serve pricing grid (the public page renders a static "Contact sales"
  // card); high session limit for big teams.
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    monthlyPrice: 0,
    yearlyPrice: 0,
=======
  // The highest App limit any legacy paid plan had, so nobody loses Apps when
  // their plan key folds into this one.
  credits: {
    name: 'credits',
    displayName: 'Credits',
>>>>>>> upstream-dev
    monthlyCredits: 0,
    canPurchaseCredits: true,
    models: ['all'],
    appLimit: 2000,
    entitlements: SELF_SERVE,
  },

  // Sales-assigned, never self-serve. Credits are granted per contract. The
  // only tier that unlocks the enterprise identity surfaces (SSO + SCIM).
  enterprise: {
    name: 'enterprise',
    displayName: 'Enterprise',
    monthlyCredits: 0,
    canPurchaseCredits: true,
    models: ['all'],
    appLimit: 5000,
    entitlements: ALL_ENTERPRISE,
  },
};

// ─── Stripe prices ───────────────────────────────────────────────────────────

interface StripePriceConfig {
  /** The $0 subscription every free account holds. */
  free: string;
  /** "Kortix credits": $0.01 per unit per month, quantity = credits. */
  credits: string;
  /** One-time top-up packages, by whole-dollar amount. */
  topUps: Record<number, string>;
}

const STRIPE_PRICES_PROD: StripePriceConfig = {
<<<<<<< HEAD
  subscriptions: {
    free: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro: { monthly: 'price_1RILb4G6l1KZGqIrhomjgDnO' }, // TODO: create prod Pro price and replace
    per_seat: { monthly: 'price_1TdyruG6l1KZGqIrMzPVmQSO' }, // live "Dosco seat" $40/mo
    // Legacy price → tier mappings (for webhook resolution of existing subs)
    tier_2_20: {
      monthly: 'price_1RILb4G6l1KZGqIrhomjgDnO',
      yearly: 'price_1ReHB5G6l1KZGqIrD70I1xqM',
      yearlyCommitment: 'price_1RqtqiG6l1KZGqIrhjVPtE1s',
    },
    tier_6_50: {
      monthly: 'price_1RILb4G6l1KZGqIr5q0sybWn',
      yearly: 'price_1ReHAsG6l1KZGqIrlAog487C',
      yearlyCommitment: 'price_1Rqtr8G6l1KZGqIrQ0ql0qHi',
    },
    tier_12_100: {
      monthly: 'price_1RILb4G6l1KZGqIr5Y20ZLHm',
      yearly: 'price_1ReHAWG6l1KZGqIrBHer2PQc',
    },
    tier_25_200: {
      monthly: 'price_1RILb4G6l1KZGqIrGAD8rNjb',
      yearly: 'price_1ReH9uG6l1KZGqIrsvMLHViC',
      yearlyCommitment: 'price_1RqtrUG6l1KZGqIrEb8hLsk3',
    },
    tier_50_400: {
      monthly: 'price_1RILb4G6l1KZGqIruNBUMTF1',
      yearly: 'price_1ReH9fG6l1KZGqIrsPtu5KIA',
    },
    tier_125_800: {
      monthly: 'price_1RILb3G6l1KZGqIrbJA766tN',
      yearly: 'price_1ReH9GG6l1KZGqIrfgqaJyat',
    },
    tier_200_1000: {
      monthly: 'price_1RILb3G6l1KZGqIrmauYPOiN',
      yearly: 'price_1ReH8qG6l1KZGqIrK1akY90q',
    },
  },
  credits: {
=======
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQEUsG6l1KZGqIrSUPCdtIO', // live "Kortix credits", $0.01/credit/month
  topUps: {
>>>>>>> upstream-dev
    10: 'price_1RxmQUG6l1KZGqIru453O1zW',
    25: 'price_1RxmQlG6l1KZGqIr3hS5WtGg',
    50: 'price_1RxmQvG6l1KZGqIrLbMZ3D6r',
    100: 'price_1RxmR3G6l1KZGqIrpLwFCGac',
    250: 'price_1RxmRAG6l1KZGqIrtBIMsZAj',
    500: 'price_1RxmRGG6l1KZGqIrSyvl6w1G',
  },
};

<<<<<<< HEAD
// Staging shares the MAIN Dosco Stripe account TEST mode (acct_1R5BVvG6l1KZGqIr)
// — the same test sandbox as STRIPE_PRICES_DEV, which is the account staging's
// deployed STRIPE_SECRET_KEY (sk_test_…) actually points at. The subscription
// price + product ids therefore mirror the dev test catalog. The older
// …G6CaZppiKc ids lived in a different account and 404 ("No such price") under
// the staging key, which broke Pro/per-seat checkout creation. The credit ids
// below are main-account test ids and already resolve.
const STRIPE_PRICES_STAGING: StripePriceConfig = {
  subscriptions: {
    free: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro: { monthly: 'price_1TeyA7G6l1KZGqIr7ZhEpoVm' },
    per_seat: { monthly: 'price_1TeyA7G6l1KZGqIrTb2DKGS0' }, // test "Dosco seat" $40/mo
  },
  credits: {
=======
// Staging and dev share the main Kortix Stripe account's TEST mode
// (acct_1R5BVvG6l1KZGqIr); both deployed keys are the same sk_test_ key.
const STRIPE_PRICES_STAGING: StripePriceConfig = {
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQERpG6l1KZGqIrIH1EuX7p',
  topUps: {
>>>>>>> upstream-dev
    10: 'price_1RxXOvG6l1KZGqIrMqsiYQvk',
    25: 'price_1RxXPNG6l1KZGqIrQprPgDme',
    50: 'price_1RxmNhG6l1KZGqIrTq2zPtgi',
    100: 'price_1RxmNwG6l1KZGqIrnliwPDM6',
    250: 'price_1RxmO6G6l1KZGqIrBF8Kx87G',
    500: 'price_1RxmOFG6l1KZGqIrn4wgORnH',
  },
};

<<<<<<< HEAD
// Local-dev Stripe TEST-mode sandbox. Every id here lives in the test mode of
// the main Dosco Stripe account (acct_1R5BVvG6l1KZGqIr) — the account your
// local `STRIPE_SECRET_KEY` (sk_test_…) points at. The prod/staging configs
// above are LIVE-mode ids in other accounts and 404 with a test key ("No such
// price"), which is why local per-seat checkout was failing. Created via the
// Stripe API; regenerate with apps/api/scripts/ or the Stripe dashboard (test
// mode) if the sandbox account is ever reset.
const STRIPE_PRICES_DEV: StripePriceConfig = {
  subscriptions: {
    free: { monthly: 'price_1RIGvuG6l1KZGqIrw14abxeL' },
    pro: { monthly: 'price_1TeyA7G6l1KZGqIr7ZhEpoVm' },
    per_seat: { monthly: 'price_1TeyA7G6l1KZGqIrTb2DKGS0' }, // test "Dosco seat" $40/mo
  },
  credits: {
=======
const STRIPE_PRICES_DEV: StripePriceConfig = {
  free: 'price_1RIGvuG6l1KZGqIrw14abxeL',
  credits: 'price_1UQERpG6l1KZGqIrIH1EuX7p',
  topUps: {
>>>>>>> upstream-dev
    10: 'price_1TeyA8G6l1KZGqIrWYDbPN0O',
    25: 'price_1TeyA9G6l1KZGqIrbdZNyyDn',
    50: 'price_1TeyA9G6l1KZGqIrNbj3otrU',
    100: 'price_1TeyA9G6l1KZGqIrqSwPsznA',
    250: 'price_1TeyAAG6l1KZGqIrZavIxtSE',
    500: 'price_1TeyAAG6l1KZGqIrm5HnnDaT',
  },
};

/**
 * Every subscription price sold before credits-only billing, and the monthly
 * credits (USD) one unit of it grants. Existing subscriptions keep their price
 * and their bill; this table is what turns each into a monthly allowance.
 *
 * Monthly prices grant their price. Yearly prices grant the plan's MONTHLY
 * allowance (price ÷ 12 would cut a yearly customer's grant by the 15% yearly
 * discount). `per_seat` grants $40 per seat (it granted $25 before; same bill,
 * more credits).
 */
const LEGACY_PRICE_MONTHLY_USD: Record<string, number> = {
  // tier_2_20 "Plus" (also legacy `pro` monthly)
  price_1RILb4G6l1KZGqIrhomjgDnO: 20,
  price_1ReHB5G6l1KZGqIrD70I1xqM: 20,
  price_1RqtqiG6l1KZGqIrhjVPtE1s: 20,
  // tier_6_50 "Pro"
  price_1RILb4G6l1KZGqIr5q0sybWn: 50,
  price_1ReHAsG6l1KZGqIrlAog487C: 50,
  price_1Rqtr8G6l1KZGqIrQ0ql0qHi: 50,
  // tier_12_100 "Business"
  price_1RILb4G6l1KZGqIr5Y20ZLHm: 100,
  price_1ReHAWG6l1KZGqIrBHer2PQc: 100,
  // tier_25_200 "Ultra"
  price_1RILb4G6l1KZGqIrGAD8rNjb: 200,
  price_1ReH9uG6l1KZGqIrsvMLHViC: 200,
  price_1RqtrUG6l1KZGqIrEb8hLsk3: 200,
  // tier_50_400
  price_1RILb4G6l1KZGqIruNBUMTF1: 400,
  price_1ReH9fG6l1KZGqIrsPtu5KIA: 400,
  // tier_125_800
  price_1RILb3G6l1KZGqIrbJA766tN: 800,
  price_1ReH9GG6l1KZGqIrfgqaJyat: 800,
  // tier_200_1000 "Max"
  price_1RILb3G6l1KZGqIrmauYPOiN: 1000,
  price_1ReH8qG6l1KZGqIrK1akY90q: 1000,
  // per_seat, live and test, per seat
  price_1TdyruG6l1KZGqIrMzPVmQSO: 40,
  price_1TeyA7G6l1KZGqIrTb2DKGS0: 40,
  // legacy `pro`, test mode
  price_1TeyA7G6l1KZGqIr7ZhEpoVm: 20,
};

/** Legacy yearly prices sold with a 12-month commitment (no cancel before term). */
const YEARLY_COMMITMENT_PRICE_IDS = new Set([
  'price_1RqtqiG6l1KZGqIrhjVPtE1s',
  'price_1Rqtr8G6l1KZGqIrQ0ql0qHi',
  'price_1RqtrUG6l1KZGqIrEb8hLsk3',
]);

const ALL_PRICE_CONFIGS = [STRIPE_PRICES_PROD, STRIPE_PRICES_STAGING, STRIPE_PRICES_DEV];

function getStripePrices(): StripePriceConfig {
  switch (config.INTERNAL_KORTIX_ENV) {
    case 'prod':
      return STRIPE_PRICES_PROD;
    case 'staging':
      return STRIPE_PRICES_STAGING;
    default:
      return STRIPE_PRICES_DEV; // 'dev' / unset → local test sandbox
  }
}

/** The free plan's $0 price for this environment. */
export function resolveFreePriceId(): string {
  return getStripePrices().free;
}

/** The "Kortix credits" price for this environment. */
export function resolveCreditsPriceId(): string {
  return getStripePrices().credits;
}

export function resolveCreditPriceId(amountDollars: number): string | null {
  return getStripePrices().topUps[amountDollars] ?? null;
}

function isCreditsPrice(priceId: string): boolean {
  return ALL_PRICE_CONFIGS.some((c) => c.credits === priceId);
}

function isFreePrice(priceId: string): boolean {
  return ALL_PRICE_CONFIGS.some((c) => c.free === priceId);
}

/** The plan a subscription PRICE pays for. Unknown prices answer null. */
export function planForPrice(priceId: string | null | undefined): 'free' | 'credits' | null {
  if (!priceId) return null;
  if (isFreePrice(priceId)) return 'free';
  if (isCreditsPrice(priceId) || priceId in LEGACY_PRICE_MONTHLY_USD) return 'credits';
  return null;
}

type SubscriptionItemLike = Pick<Stripe.SubscriptionItem, 'quantity'> & {
  price?: Pick<Stripe.Price, 'id' | 'unit_amount' | 'recurring'> | null;
};

/**
 * The plan a SUBSCRIPTION pays for — the only trustworthy answer to "which plan
 * did this customer buy". In order:
 *   1. a known price (free, credits, a legacy plan price);
 *   2. our own metadata (`plan_key`, `tier_key`, or the oldest key, `tier`),
 *      for prices this table never saw (legacy machine subscriptions);
 *   3. the amount: any price above $0 is the one paid plan, Credits. There is
 *      no other plan to buy, so a paying subscription is never left without one
 *      (a 2026-10-15 prod audit found paying subscriptions with neither a known
 *      price nor metadata). An all-$0 subscription with no metadata answers
 *      null: the stored plan decides, so a comped account keeps its plan.
 */
export function planForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
  metadata?: Stripe.Metadata | null;
}): 'free' | 'credits' | null {
  for (const item of subscription.items.data) {
    const plan = planForPrice(item.price?.id);
    if (plan) return plan;
  }
  // Metadata is a hint the provider owns. `enterprise` is not a provider plan:
  // it is set by a contract or an operator (applyAdminOverride), so a metadata
  // hint that canonicalizes to it is ignored, not applied (2026-10-15 dev:
  // such a hint made the next subscription sync throw AccountWriteOwnershipError).
  const meta = subscription.metadata;
  const hint = canonicalTier(meta?.plan_key || meta?.tier_key || meta?.tier);
  if (hint === 'free' || hint === 'credits') return hint;
  return subscription.items.data.some((item) => (item.price?.unit_amount ?? 0) > 0) ? 'credits' : null;
}

/**
 * THE allowance rule: the credits (USD) one month of this subscription grants.
 * Σ items: monthly credits per unit × quantity. Discounts do not reduce it —
 * the allowance is what the plan lists, as the seat rule always was.
 *
 *   - "Kortix credits": $0.01 × quantity.
 *   - A legacy price: its row in LEGACY_PRICE_MONTHLY_USD.
 *   - Any other price (a legacy machine subscription): its list price per month.
 *
 * Pure — testable without Stripe or a DB.
 */
export function monthlyCreditsForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
}): number {
  let cents = 0;
  for (const item of subscription.items.data) {
    const quantity = Math.max(0, item.quantity ?? 1);
    const price = item.price;
    if (!price) continue;
    if (isCreditsPrice(price.id)) cents += quantity;
    else if (price.id in LEGACY_PRICE_MONTHLY_USD) cents += LEGACY_PRICE_MONTHLY_USD[price.id] * 100 * quantity;
    else {
      const perMonth = price.recurring?.interval === 'year' ? (price.unit_amount ?? 0) / 12 : (price.unit_amount ?? 0);
      cents += Math.round(perMonth) * quantity;
    }
  }
  return cents / 100;
}

/** Billing period of a subscription's first item. */
export function billingPeriodForSubscription(subscription: {
  items: { data: SubscriptionItemLike[] };
}): 'monthly' | 'yearly' | 'yearly_commitment' {
  const price = subscription.items.data[0]?.price;
  if (price && YEARLY_COMMITMENT_PRICE_IDS.has(price.id)) return 'yearly_commitment';
  return price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
}

/**
 * Monthly allowance of a row written before credits-only billing, which has no
 * `plan_monthly_usd` yet: the legacy plan's price, or $40 per seat.
 * ponytail: transitional; delete once the backfill has written every paid row.
 */
const LEGACY_TIER_MONTHLY_USD: Record<string, number> = {
  pro: 20,
  tier_2_20: 20,
  tier_6_50: 50,
  tier_12_100: 100,
  tier_25_200: 200,
  tier_50_400: 400,
  tier_125_800: 800,
  tier_200_1000: 1000,
  tier_150_1200: 1200,
};

/** The monthly allowance (USD) an account's plan grants. */
export function planMonthlyUsd(row: {
  tier?: string | null;
  planMonthlyUsd?: string | number | null;
  seatCount?: number | null;
}): number {
  const stored = Number(row.planMonthlyUsd);
  if (row.planMonthlyUsd != null && Number.isFinite(stored)) return stored;
  const tier = row.tier ?? 'none';
  if (tier === 'per_seat') return 40 * Math.max(1, row.seatCount ?? 1);
  return LEGACY_TIER_MONTHLY_USD[tier] ?? getTier(tier).monthlyCredits;
}

/**
 * The monthly allowance of a PAID account billed by `subscription`. The
 * subscription's list price decides, except for a comped account: support
 * assigns a paid plan to an account that stays on a $0 price, and that account
 * keeps its stored (or legacy) monthly amount.
 */
export function paidMonthlyUsd(
  subscription: { items: { data: SubscriptionItemLike[] } },
  row: Parameters<typeof planMonthlyUsd>[0] | null | undefined,
): number {
  const fromSubscription = monthlyCreditsForSubscription(subscription);
  return fromSubscription > 0 || !row ? fromSubscription : planMonthlyUsd(row);
}

// ─── Tier helpers ────────────────────────────────────────────────────────────

/** The plan config a stored tier key means. Legacy keys resolve to `credits`. */
export function getTier(name: string): TierConfig {
  return TIERS[canonicalTier(name)];
}

export function isValidTier(name: string): boolean {
  return name in TIERS;
}

/**
 * Whether a tier unlocks the full model catalog — the premium LLM gateway
 * (Claude/GPT/Gemini/…), not just OpenCode's built-in models. Pure function of
 * tier config: environment and wallet balance cannot grant it.
 */
export function tierGrantsAllModels(tierName: string): boolean {
  return getTier(tierName).models.includes('all');
}

<<<<<<< HEAD
/**
 * Whether a resolved billing tier is blocked from Dosco-managed models.
 *
 * The environment argument remains for source compatibility. It has no effect.
 * `free`, `none`, and unknown tiers are blocked in every environment.
 */
export function accountIsFreeTierForModels(
  tierName: string,
  _env: string = config.INTERNAL_KORTIX_ENV,
): boolean {
  return !tierGrantsAllModels(tierName);
}

=======
>>>>>>> upstream-dev
/** Full entitlement set for a tier (enterprise feature gates). */
export function getTierEntitlements(tierName: string): TierEntitlements {
  return getTier(tierName).entitlements;
}

// ─── RevenueCat (mobile in-app purchases) ────────────────────────────────────
// The store sells fixed products, so mobile keeps them. Each maps to `credits`
// with the monthly allowance it grants.

const REVENUECAT_PRODUCT_MONTHLY_USD: Record<string, number> = {
  kortix_plus_monthly: 20,
  kortix_plus_yearly: 20,
  'plus:plus-monthly': 20,
  plus: 20,
  kortix_pro_monthly: 20,
  kortix_pro_yearly: 20,
  'pro:pro-monthly': 20,
  kortix_ultra_monthly: 200,
  kortix_ultra_yearly: 200,
  'ultra:ultra-monthly': 200,
};

/** Monthly allowance (USD) of a RevenueCat product, or null when the product is unknown. */
export function revenueCatProductMonthlyUsd(productId: string): number | null {
  return REVENUECAT_PRODUCT_MONTHLY_USD[productId.toLowerCase()] ?? null;
}

export function getRevenueCatPeriodType(
  productId: string,
): 'monthly' | 'yearly' | 'yearly_commitment' {
  if (!productId) return 'monthly';
  const lower = productId.toLowerCase();
  if (lower.includes('commitment')) return 'yearly_commitment';
  if (lower.includes('yearly') || lower.includes('annual')) return 'yearly';
  return 'monthly';
}

export function isRevenueCatAnonymous(appUserId: string): boolean {
  return appUserId.startsWith('$RCAnonymousID:');
}
