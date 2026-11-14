import { describe, expect, test } from 'bun:test';

import { relativeAge, relativeShort, relativeUntil } from './relative-time.ts';

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const minutes = (n: number) => NOW - n * 60_000;
const hours = (n: number) => NOW - n * 3_600_000;
const days = (n: number) => NOW - n * 86_400_000;

describe('relativeAge', () => {
  test('under a minute reads `now`', () => {
    expect(relativeAge(NOW, NOW)).toBe('now');
    expect(relativeAge(NOW - 59_000, NOW)).toBe('now');
  });

  test('minutes, hours and days each get their own unit', () => {
    expect(relativeAge(minutes(1), NOW)).toBe('1m');
    expect(relativeAge(minutes(59), NOW)).toBe('59m');
    expect(relativeAge(hours(1), NOW)).toBe('1h');
    expect(relativeAge(hours(23), NOW)).toBe('23h');
    expect(relativeAge(days(1), NOW)).toBe('1d');
    expect(relativeAge(days(29), NOW)).toBe('29d');
  });

  test('months and years bucket the long tail', () => {
    expect(relativeAge(days(30), NOW)).toBe('1mo');
    expect(relativeAge(days(364), NOW)).toBe('12mo');
    expect(relativeAge(days(365), NOW)).toBe('1y');
    expect(relativeAge(days(900), NOW)).toBe('2y');
  });

  test('never prints more than four columns', () => {
    for (const ms of [NOW, minutes(7), hours(9), days(3), days(200), days(4000)]) {
      expect(relativeAge(ms, NOW).length).toBeLessThanOrEqual(4);
    }
  });

  test('a future timestamp reads `now`, not a negative age', () => {
    expect(relativeAge(NOW + 90_000, NOW)).toBe('now');
  });

  test('an unparseable timestamp renders nothing', () => {
    expect(relativeAge(Number.NaN, NOW)).toBe('');
  });
});

describe('relativeShort', () => {
  test('`now` under 5 s, then seconds, minutes, hours and days each get their step', () => {
    expect(relativeShort(1_000)).toBe('now');
    expect(relativeShort(4_999)).toBe('now');
    expect(relativeShort(5_000)).toBe('5s');
    expect(relativeShort(42_000)).toBe('42s');
    expect(relativeShort(4 * 60_000)).toBe('4m');
    expect(relativeShort(59 * 60_000)).toBe('59m');
    expect(relativeShort(3 * 3_600_000)).toBe('3h');
    expect(relativeShort(23 * 3_600_000)).toBe('23h');
    expect(relativeShort(24 * 3_600_000)).toBe('1d');
    expect(relativeShort(50 * 3_600_000)).toBe('2d');
  });

  test('a negative elapsed reads as `now`, never a negative age', () => {
    expect(relativeShort(-90_000)).toBe('now');
  });

  test('a non-finite elapsed renders the NaN bucket (callers guard the instant)', () => {
    expect(relativeShort(Number.NaN)).toBe('NaNd');
  });
});

describe('relativeUntil', () => {
  const soon = (ms: number) => NOW + ms;

  test('minutes round up under an hour', () => {
    expect(relativeUntil(soon(1), NOW)).toBe('in 1m');
    expect(relativeUntil(soon(20 * 60_000), NOW)).toBe('in 20m');
    expect(relativeUntil(soon(59 * 60_000 + 30_000), NOW)).toBe('in 1h');
  });

  test('hours run to 48 before the day step', () => {
    expect(relativeUntil(soon(3 * 3_600_000), NOW)).toBe('in 3h');
    expect(relativeUntil(soon(47 * 3_600_000), NOW)).toBe('in 47h');
    expect(relativeUntil(soon(72 * 3_600_000), NOW)).toBe('in 3d');
  });

  test('a past instant is `due`', () => {
    expect(relativeUntil(NOW, NOW)).toBe('due');
    expect(relativeUntil(NOW - 1, NOW)).toBe('due');
  });

  test('a non-finite instant renders the empty column marker', () => {
    expect(relativeUntil(Number.NaN, NOW)).toBe('—');
  });
});
