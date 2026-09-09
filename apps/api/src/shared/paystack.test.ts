import { describe, expect, mock, test } from 'bun:test';

// The client module reads env-backed config at import; the money math under
// test takes every input as an argument, so a bare config stub suffices.
mock.module('../config', () => ({ config: {} }));

const { PAYSTACK_CHARGE_CURRENCY, ngnSubunitsToUsd, toSubunits, usdToNgn } =
  await import('./paystack');

describe('Paystack NGN money math', () => {
  test('this deployment charges NGN', () => {
    expect(PAYSTACK_CHARGE_CURRENCY).toBe('NGN');
  });

  test('usdToNgn rounds to whole naira, never truncates', () => {
    expect(usdToNgn(40, 1500)).toBe(60000);
    // 10 × 1533.33 = 15333.3 → 15333 (round), not 15333.3 floored or kept.
    expect(usdToNgn(10, 1533.33)).toBe(15333);
    expect(usdToNgn(0.01, 1500)).toBe(15);
  });

  test('toSubunits converts major units to minor (naira to kobo)', () => {
    expect(toSubunits(60000)).toBe(6000000);
    expect(toSubunits(0)).toBe(0);
  });

  test('ngnSubunitsToUsd inverts to the cent for the USD ledger', () => {
    expect(ngnSubunitsToUsd(6000000, 1500)).toBe(40);
    expect(ngnSubunitsToUsd(1533300, 1533.33)).toBeCloseTo(10, 2);
  });

  test('USD → NGN → USD round trip holds within a cent', () => {
    for (const [usd, rate] of [[27.5, 1487.6], [5, 1600], [100, 1425.05]] as const) {
      const kobo = toSubunits(usdToNgn(usd, rate));
      expect(Math.abs(ngnSubunitsToUsd(kobo, rate) - usd)).toBeLessThanOrEqual(0.01);
    }
  });
});
