import { describe, expect, test } from 'bun:test';

import { formatClock } from './format-clock';

describe('formatClock', () => {
  test('m:ss, minutes unbounded', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(72)).toBe('1:12');
    expect(formatClock(3_725)).toBe('62:05');
  });

  test('padMinutes pads the minutes column (the release list reads 00:05)', () => {
    expect(formatClock(5, { padMinutes: true })).toBe('00:05');
    expect(formatClock(3_725, { padMinutes: true })).toBe('62:05');
  });
});
