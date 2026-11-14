import { describe, expect, test } from 'bun:test';

import { toastClearance } from './toast-clearance';

const DESKTOP = { width: 1440, height: 900 };

describe('toastClearance', () => {
  test('a session composer at the window bottom lifts toasts above its top edge', () => {
    // The audit's composer: Send button at y 820–848, card top ≈ 780.
    expect(toastClearance({ top: 780, bottom: 880, right: 1260, width: 760, height: 100 }, DESKTOP)).toBe(132);
  });

  test('a hidden (pre-mounted) composer asks for nothing', () => {
    expect(toastClearance({ top: 0, bottom: 0, right: 0, width: 0, height: 0 }, DESKTOP)).toBe(0);
  });

  test('a composer left of the toast lane asks for nothing', () => {
    expect(toastClearance({ top: 780, bottom: 880, right: 900, width: 600, height: 100 }, DESKTOP)).toBe(0);
  });

  test('a composer that is not docked at the bottom asks for nothing', () => {
    expect(toastClearance({ top: 380, bottom: 540, right: 1100, width: 760, height: 160 }, DESKTOP)).toBe(0);
  });

  test('a tall docked composer (top above the middle) still lifts toasts', () => {
    expect(toastClearance({ top: 300, bottom: 880, right: 1260, width: 760, height: 580 }, DESKTOP)).toBe(612);
  });

  test('on a phone every bottom composer is in the lane', () => {
    expect(toastClearance({ top: 700, bottom: 820, right: 380, width: 360, height: 120 }, { width: 390, height: 844 })).toBe(156);
  });
});
