import { describe, expect, test } from 'bun:test';

import {
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_PEEK,
  PEEK_CARD_VEIL,
  SIDEBAR_DIM,
  drawerSwipeEdgeWidth,
  peekCardFrame,
  projectDrawerWidth,
  sidebarDim,
} from './drawer-layout';

describe('projectDrawerWidth', () => {
  test('a phone in portrait: 82% of the window', () => {
    expect(projectDrawerWidth(375)).toBe(308); // iPhone SE: 67pt peek
    expect(projectDrawerWidth(393)).toBe(322); // iPhone 16: 71pt peek
  });

  test('a large phone, landscape and iPad: capped at 360', () => {
    expect(projectDrawerWidth(440)).toBe(DRAWER_MAX_WIDTH);
    expect(projectDrawerWidth(874)).toBe(DRAWER_MAX_WIDTH);
    expect(projectDrawerWidth(1024)).toBe(DRAWER_MAX_WIDTH);
  });

  test('the peek strip never drops under 56pt', () => {
    expect(projectDrawerWidth(280)).toBe(280 - DRAWER_MIN_PEEK);
  });

  test('no window yet: 0, never NaN', () => {
    expect(projectDrawerWidth(0)).toBe(0);
    expect(projectDrawerWidth(Number.NaN)).toBe(0);
  });
});

describe('peekCardFrame', () => {
  test('closed: a plain page', () => {
    expect(peekCardFrame(0, 44)).toEqual({ borderRadius: 0, veil: 0 });
  });

  test('open: the rounded card, its content faded toward the page colour, full size', () => {
    const open = peekCardFrame(1, 44);
    expect(open.borderRadius).toBe(44);
    expect(open.veil).toBeCloseTo(PEEK_CARD_VEIL, 6);
  });

  test('moving: the full radius by 1/8 of the travel (Claude iOS), the veil linear so it tracks the finger', () => {
    expect(peekCardFrame(0.0625, 44).borderRadius).toBe(22); // a ramp, no 0 → 44 step
    expect(peekCardFrame(0.125, 44).borderRadius).toBe(44);
    const half = peekCardFrame(0.5, 44);
    expect(half.borderRadius).toBe(44);
    expect(half.veil).toBeCloseTo(PEEK_CARD_VEIL / 2, 6);
  });

  test('card: progress outside 0…1 (a spring) is clamped', () => {
    expect(peekCardFrame(1.2, 44).borderRadius).toBe(44);
    expect(peekCardFrame(-0.1, 44).borderRadius).toBe(0);
  });
});

describe('sidebarDim', () => {
  test('open: the sidebar at full light', () => {
    expect(sidebarDim(1, SIDEBAR_DIM.light)).toBe(0);
  });

  test('closing: darker as the card covers it, linear so it tracks the finger', () => {
    expect(sidebarDim(0.5, SIDEBAR_DIM.light)).toBeCloseTo(SIDEBAR_DIM.light / 2, 6);
    expect(sidebarDim(0, SIDEBAR_DIM.light)).toBeCloseTo(SIDEBAR_DIM.light, 6);
  });

  test('the Claude iOS dim: ~45% black under a closed card in light mode', () => {
    expect(SIDEBAR_DIM.light).toBeCloseTo(0.45, 2);
    expect(SIDEBAR_DIM.dark).toBeGreaterThan(SIDEBAR_DIM.light);
  });

  test('dim: progress outside 0…1 (a spring) is clamped', () => {
    expect(sidebarDim(1.2, SIDEBAR_DIM.light)).toBe(0);
    expect(sidebarDim(-0.1, SIDEBAR_DIM.light)).toBeCloseTo(SIDEBAR_DIM.light, 6);
  });
});

describe('drawerSwipeEdgeWidth', () => {
  test('a thread: the left third, so sideways scrollers keep the rest', () => {
    expect(drawerSwipeEdgeWidth('view', 393)).toBe(131);
  });

  test('every other project route: the whole page', () => {
    for (const route of ['index', 'sessions', 'files', 'account', 'inbox', null]) {
      expect(drawerSwipeEdgeWidth(route, 393)).toBe(393);
    }
  });
});
