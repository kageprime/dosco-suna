import { describe, expect, test } from 'bun:test';
import {
  CREDIT_TIER_GROUPS,
  CREDIT_TIERS,
  CREDITS_PLAN_MAX_USD,
  CREDITS_PLAN_MIN_USD,
  DEFAULT_COMPUTE_CREDITS_PER_HOUR,
  DEFAULT_COMPUTE_HOURLY_PRICE_USD,
  DEFAULT_TIER_USD,
  ENTRY_TIER_USD,
  creditsForUsd,
  isValidMonthlyUsd,
  monthlyCreditsForUsd,
  PLAN_BONUS_STEPS,
  planBonusPercent,
  agentHoursForCredits,
  MINUTES_PER_CREDIT,
  PLATFORM_FEE_PERCENT,
  DEFAULT_COMPUTE_SPEC,
  tierForMonthlyUsd,
} from './compute-pricing';

describe('credit tier ladder', () => {
  test('runs $50 to $10,000 in 16 tiers, ascending, every tier a valid API amount', () => {
    expect(CREDIT_TIERS).toHaveLength(16);
    const amounts = CREDIT_TIERS.map((tier) => tier.monthlyUsd);
    expect(amounts[0]).toBe(CREDITS_PLAN_MIN_USD);
    expect(amounts.at(-1)).toBe(CREDITS_PLAN_MAX_USD);
    expect([...amounts].sort((a, b) => a - b)).toEqual(amounts);
    for (const amount of amounts) expect(isValidMonthlyUsd(amount)).toBe(true);
  });

  test('exactly one tier is most popular, and /pricing opens on it: $200', () => {
    expect(CREDIT_TIERS.filter((tier) => tier.popular).map((tier) => tier.monthlyUsd)).toEqual([200]);
    expect(DEFAULT_TIER_USD).toBe(200);
  });

  test('an in-app upgrade opens on the entry tier, the "From $50" price', () => {
    expect(ENTRY_TIER_USD).toBe(50);
    expect(ENTRY_TIER_USD).toBe(CREDITS_PLAN_MIN_USD);
  });

  test('every group has tiers, in ladder order', () => {
    const groups = CREDIT_TIERS.map((tier) => tier.group);
    expect([...new Set(groups)]).toEqual([...CREDIT_TIER_GROUPS]);
  });

  test('a bigger tier buys more credits per dollar: +5% at $100 up to +30% from $7,500', () => {
    expect(CREDIT_TIERS.map((tier) => [tier.monthlyUsd, monthlyCreditsForUsd(tier.monthlyUsd)])).toEqual([
      [50, 5_000], [75, 7_500], [100, 10_500], [200, 22_000], [300, 33_000], [400, 44_000], [500, 57_500],
      [750, 86_250], [1_000, 120_000], [1_500, 180_000], [2_000, 240_000], [3_000, 375_000], [4_000, 500_000],
      [5_000, 625_000], [7_500, 975_000], [10_000, 1_300_000],
    ]);
    for (let i = 1; i < CREDIT_TIERS.length; i++) {
      const [prev, next] = [CREDIT_TIERS[i - 1].monthlyUsd, CREDIT_TIERS[i].monthlyUsd];
      expect(monthlyCreditsForUsd(next) / next).toBeGreaterThanOrEqual(monthlyCreditsForUsd(prev) / prev);
    }
    expect(Math.max(...PLAN_BONUS_STEPS.map((step) => step.percent))).toBe(30);
    expect(planBonusPercent(99)).toBe(0);
  });

  test('a top-up buys at the flat rate: 100 credits per dollar, no bonus', () => {
    for (const amount of [10, 50, 500, 5_000]) expect(creditsForUsd(amount)).toBe(amount * 100);
  });

  test('an off-ladder amount (a legacy $20 plan) has no tier', () => {
    expect(tierForMonthlyUsd(20)).toBeUndefined();
    expect(tierForMonthlyUsd(null)).toBeUndefined();
    expect(tierForMonthlyUsd(500)?.group).toBe('growing');
  });

  test('valid amounts are whole dollars from $50 to $10,000', () => {
    expect(isValidMonthlyUsd(49)).toBe(false);
    expect(isValidMonthlyUsd(20)).toBe(false);
    expect(isValidMonthlyUsd(10_000)).toBe(true);
    expect(isValidMonthlyUsd(10_001)).toBe(false);
    expect(isValidMonthlyUsd(50_000)).toBe(false);
    expect(isValidMonthlyUsd(75.5)).toBe(false);
    expect(isValidMonthlyUsd(null)).toBe(false);
    expect(isValidMonthlyUsd(Number.NaN)).toBe(false);
  });
});

describe('what credits buy', () => {
  test('the default computer uses about 11 credits a running hour, at Platinum rates', () => {
    // 2 × $0.0324 + 4 × $0.0108 + 20 GB × $0.0526 / 730 h
    expect(DEFAULT_COMPUTE_HOURLY_PRICE_USD).toBeCloseTo(0.109441, 6);
    expect(DEFAULT_COMPUTE_CREDITS_PER_HOUR).toBe(11);
  });

  test('one credit is about 5 minutes of agent computer', () => {
    expect(MINUTES_PER_CREDIT).toBe(5);
    expect(DEFAULT_COMPUTE_SPEC).toBe('2 vCPU / 4 GB / 20 GB');
  });

  test('hours estimate: credits / hourly price, rounded to 10 from 100 up', () => {
    expect(agentHoursForCredits(20_000)).toBe(1830);
    expect(agentHoursForCredits(5_000)).toBe(460);
    expect(agentHoursForCredits(1_000)).toBe(91);
    expect(agentHoursForCredits(2_130)).toBe(190);
  });

  test('the platform fee on Dosco models is 5.5%', () => {
    expect(PLATFORM_FEE_PERCENT).toBe(5.5);
  });
});
