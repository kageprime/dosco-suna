import { describe, expect, test } from 'bun:test';
import { computeProrationGrant, type ProrationLine } from './proration-grants';

const line = (amount: number, proration = true): ProrationLine => ({ amount, proration });
// "Kortix credits" (test mode): quantity = the monthly amount in cents.
const CREDITS_PRICE = { id: 'price_1UQERpG6l1KZGqIrIH1EuX7p', unit_amount: 1, recurring: { interval: 'month' } } as never;
const planLine = (amount: number, monthlyUsd: number): ProrationLine => ({
  amount,
  proration: true,
  price: CREDITS_PRICE,
  quantity: monthlyUsd * 100,
});

describe('computeProrationGrant', () => {
  test('a line with no plan price converts 1:1 (`credits` is the wallet unit, USD)', () => {
    // $200 → $300 with 40% of the period left: -$80 unused + $120 new = $40.
    expect(computeProrationGrant([line(-8000), line(12000)])).toEqual({
      kind: 'raise',
      netCents: 4000,
      credits: 40,
    });
  });

  test('a raise inside one bonus step grants the net amount plus that step\'s bonus', () => {
    // $200 → $300 (both +10%), 40% left: -$80 + $120 = $40 paid → 4,400 credits.
    expect(computeProrationGrant([planLine(-8000, 200), planLine(12000, 300)])).toEqual({
      kind: 'raise',
      netCents: 4000,
      credits: 44,
    });
  });

  test('a raise across bonus steps grants exactly the remaining share of the credits difference', () => {
    // $500 (+15%, 57,500 credits) → $1,000 (+20%, 120,000 credits), half the
    // period left: $250 paid, half of the 62,500-credit difference = 31,250.
    expect(computeProrationGrant([planLine(-25000, 500), planLine(50000, 1000)])).toEqual({
      kind: 'raise',
      netCents: 25000,
      credits: 312.5,
    });
  });

  test('a raise late in the period buys proportionally fewer credits', () => {
    // 1/30 of the period left: -$6.67 unused + $10.00 new = $3.33.
    const decision = computeProrationGrant([line(-667), line(1000)]);
    expect(decision).toEqual({ kind: 'raise', netCents: 333, credits: 3.33 });
  });

  test('a cut collects no money and grants nothing', () => {
    const decision = computeProrationGrant([line(-5000), line(2500)]);
    expect(decision.kind).toBe('none');
  });

  test('a lone unused-time credit grants nothing', () => {
    expect(computeProrationGrant([line(-4000)]).kind).toBe('none');
  });

  test('non-proration lines are ignored', () => {
    const decision = computeProrationGrant([line(4000, false)]);
    expect(decision).toEqual({ kind: 'none', reason: 'no proration lines' });
  });

  test('a net zero change grants nothing', () => {
    expect(computeProrationGrant([line(-2500), line(2500)]).kind).toBe('none');
  });
});
