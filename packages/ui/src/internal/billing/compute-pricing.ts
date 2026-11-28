export const CREDITS_PER_USD = 100;

/**
 * Compute list rates: Platinum's, at 1× on every provider. Mirrors the rate
 * card in apps/api (`platform/providers/compute-rates.ts`), which bills per
 * second for the reserved spec.
 */
export const COMPUTE_RATES_USD = {
  vcpuHour: 0.0324,
  memoryGbHour: 0.0108,
  diskGbMonth: 0.0526,
} as const;

/** Hours in a billing month for the per-month disk rate (365 × 24 / 12). */
const HOURS_PER_MONTH = 730;

/** The default agent computer, as the plan pages name it. */
export const DEFAULT_COMPUTE_RESOURCES = { vcpu: 2, memoryGb: 4, diskGb: 20 } as const;

/** USD a running hour of the default agent computer costs. */
export const DEFAULT_COMPUTE_HOURLY_PRICE_USD =
  DEFAULT_COMPUTE_RESOURCES.vcpu * COMPUTE_RATES_USD.vcpuHour +
  DEFAULT_COMPUTE_RESOURCES.memoryGb * COMPUTE_RATES_USD.memoryGbHour +
  (DEFAULT_COMPUTE_RESOURCES.diskGb * COMPUTE_RATES_USD.diskGbMonth) / HOURS_PER_MONTH;

/**
 * The credits plan: one paid plan, sold as a tier ladder of monthly amounts.
 * A bigger tier buys more credits per dollar (`PLAN_BONUS_STEPS`). The bounds
 * mirror `PLAN_MIN_MONTHLY_USD` / `PLAN_MAX_MONTHLY_USD` in apps/api
 * (`GET /v1/billing/tier-configurations` returns the same ladder);
 * `POST /v1/billing/plan` answers 400 outside them. Sales above the top.
 */
export const CREDITS_PLAN_MIN_USD = 50;
export const CREDITS_PLAN_MAX_USD = 10_000;

/** The Free plan's monthly grant, in credits. */
export const FREE_MONTHLY_CREDITS = 500;

export type CreditTierGroup = 'small' | 'growing' | 'scale';

export interface CreditTier {
  monthlyUsd: number;
  group: CreditTierGroup;
  /** The most common paid amount at or above the minimum. */
  popular?: boolean;
}

/** The tier ladder, smallest first. Mirrors `PLAN_PRESETS` in apps/api. */
export const CREDIT_TIERS: readonly CreditTier[] = [
  { monthlyUsd: 50, group: 'small' },
  { monthlyUsd: 75, group: 'small' },
  { monthlyUsd: 100, group: 'small' },
  { monthlyUsd: 200, group: 'small', popular: true },
  { monthlyUsd: 300, group: 'growing' },
  { monthlyUsd: 400, group: 'growing' },
  { monthlyUsd: 500, group: 'growing' },
  { monthlyUsd: 750, group: 'growing' },
  { monthlyUsd: 1_000, group: 'growing' },
  { monthlyUsd: 1_500, group: 'growing' },
  { monthlyUsd: 2_000, group: 'growing' },
  { monthlyUsd: 3_000, group: 'scale' },
  { monthlyUsd: 4_000, group: 'scale' },
  { monthlyUsd: 5_000, group: 'scale' },
  { monthlyUsd: 7_500, group: 'scale' },
  { monthlyUsd: 10_000, group: 'scale' },
];

export const CREDIT_TIER_GROUPS: readonly CreditTierGroup[] = ['small', 'growing', 'scale'];

/**
 * Plan volume bonus: a monthly plan of at least `minUsd` grants `percent` more
 * credits than it bills. Largest step first. Mirrors `PLAN_BONUS_STEPS` in
 * apps/api (`billing/services/tiers.ts`), which grants it. Top-ups carry no
 * bonus: the plan is the volume discount.
 */
export const PLAN_BONUS_STEPS = [
  { minUsd: 7_500, percent: 30 },
  { minUsd: 3_000, percent: 25 },
  { minUsd: 1_000, percent: 20 },
  { minUsd: 500, percent: 15 },
  { minUsd: 200, percent: 10 },
  { minUsd: 100, percent: 5 },
] as const;

/** Bonus percent a monthly plan of `monthlyUsd` earns. 0 below $100. */
export function planBonusPercent(monthlyUsd: number): number {
  return PLAN_BONUS_STEPS.find((s) => monthlyUsd >= s.minUsd)?.percent ?? 0;
}

/** The tier the marketing /pricing page opens on: the most popular one. */
export const DEFAULT_TIER_USD = CREDIT_TIERS.find((tier) => tier.popular)!.monthlyUsd;

/**
 * The tier an in-app upgrade opens on for an account with no plan: the
 * smallest one, the "From $50" price the Credits card names. Opening on a
 * larger tier quotes a price the copy never mentioned.
 */
export const ENTRY_TIER_USD = CREDIT_TIERS[0].monthlyUsd;

/** The ladder tier for an amount, or `undefined` for an amount off the ladder (a legacy plan). */
export function tierForMonthlyUsd(monthlyUsd: number | null | undefined): CreditTier | undefined {
  return CREDIT_TIERS.find((tier) => tier.monthlyUsd === monthlyUsd);
}

/** Whether `monthlyUsd` is an amount the API accepts: a whole dollar in range. */
export function isValidMonthlyUsd(monthlyUsd: number | null | undefined): monthlyUsd is number {
  return (
    typeof monthlyUsd === 'number' &&
    Number.isInteger(monthlyUsd) &&
    monthlyUsd >= CREDITS_PLAN_MIN_USD &&
    monthlyUsd <= CREDITS_PLAN_MAX_USD
  );
}

/** Credits a one-time dollar amount (a top-up) buys: the flat rate, no bonus. */
export function creditsForUsd(amountUsd: number): number {
  return Math.round(amountUsd * CREDITS_PER_USD);
}

/** Credits a monthly plan of `monthlyUsd` grants: the amount plus its volume bonus. */
export function monthlyCreditsForUsd(monthlyUsd: number): number {
  if (!(monthlyUsd > 0)) return 0;
  return Math.round(monthlyUsd * (100 + planBonusPercent(monthlyUsd)));
}

/** Credits the default agent computer uses per running hour. */
export const DEFAULT_COMPUTE_CREDITS_PER_HOUR = Math.round(
  DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD,
);

/** The default agent computer, as the plan pages name it. */
export const DEFAULT_COMPUTE_SPEC = `${DEFAULT_COMPUTE_RESOURCES.vcpu} vCPU / ${DEFAULT_COMPUTE_RESOURCES.memoryGb} GB / ${DEFAULT_COMPUTE_RESOURCES.diskGb} GB`;

/** Minutes of default agent computer one credit buys (60 / credits per hour). */
export const MINUTES_PER_CREDIT = Math.round(60 / DEFAULT_COMPUTE_CREDITS_PER_HOUR);

/**
 * Dosco's platform fee on Dosco-model usage, in percent of the provider's
 * base price. Mirrors `platformFeePercent` from `GET /v1/projects/{id}/models`;
 * the app reads the served value, this constant is for pages with no API call.
 */
export const PLATFORM_FEE_PERCENT = 5.5;

/** Hours of default agent computer a credit amount buys, rounded to 10 from 100 up. */
export function agentHoursForCredits(credits: number): number {
  const hours = credits / (DEFAULT_COMPUTE_HOURLY_PRICE_USD * CREDITS_PER_USD);
  return hours >= 100 ? Math.round(hours / 10) * 10 : Math.round(hours);
}

/** `$100` — whole dollars, no decimals, in the reader's locale. */
export function formatWholeUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
