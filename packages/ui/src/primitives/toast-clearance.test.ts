import { describe, expect, test } from 'bun:test';

import { toastClearance, toastRightOffset } from './toast-clearance';

const DESKTOP = { width: 1440, height: 900 };

const DESKTOP_WIDE = { width: 1440 };

describe('toastClearance', () => {
  test('a session composer at the window bottom lifts toasts above its top edge', () => {
    // The audit's composer: Send button at y 820–848, card top ≈ 780.
    expect(toastClearance({ top: 780, bottom: 880, right: 1260, width: 760, height: 100 }, DESKTOP)).toBe(132);
  });

  test('a hidden (pre-mounted) composer asks for nothing', () => {
    expect(toastClearance({ top: 0, bottom: 0, right: 0, width: 0, height: 0 }, DESKTOP)).toBe(0);
  });

  test('a docked composer left of the window corner still hosts the toast above it', () => {
    // A side panel fills the window's right edge; the toast must not straddle it.
    expect(toastClearance({ top: 780, bottom: 880, right: 900, width: 600, height: 100 }, DESKTOP)).toBe(132);
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

describe('toastRightOffset', () => {
  test('a lifted toast aligns its right edge with the composer, clear of a side panel', () => {
    // Composer ends at x=1100; a 340px panel fills the rest of a 1440px window.
    expect(toastRightOffset({ right: 1100 }, DESKTOP_WIDE, 132)).toBe(340);
  });

  test('an unlifted toast keeps the default right offset', () => {
    expect(toastRightOffset({ right: 1100 }, DESKTOP_WIDE, 0)).toBe(0);
  });

  test('never closer to the window edge than 24px', () => {
    expect(toastRightOffset({ right: 1430 }, DESKTOP_WIDE, 132)).toBe(24);
  });

  test('never past the left window edge: a narrow window with a wide panel', () => {
    // 720px window, composer ends at x=300: right-aligning would start the
    // 356px toast at -56px. Clamp so it starts 24px from the left edge.
    expect(toastRightOffset({ right: 300 }, { width: 720 }, 132)).toBe(340);
  });

  test('a phone stacks toasts full width: no right offset', () => {
    expect(toastRightOffset({ right: 380 }, { width: 390 }, 156)).toBe(0);
  });
});

