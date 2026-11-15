import { describe, expect, test } from 'bun:test';

import { scrollTopToReveal } from './workspace-settings-sidebar-nav';

// The settings nav list measured at 1440x900: its box is 118-855 px.
const LIST = { top: 118, bottom: 855 };

describe('scrollTopToReveal', () => {
  test('a row inside the list leaves it where it is', () => {
    expect(scrollTopToReveal(LIST, { top: 300, bottom: 329 }, 0)).toBeNull();
  });

  test('Danger zone below the fold scrolls the list just enough to show it', () => {
    // Danger zone at 969-998 with scrollTop 0: 143 px below the list's bottom.
    expect(scrollTopToReveal(LIST, { top: 969, bottom: 998 }, 0)).toBe(143);
  });

  test('a row above the list scrolls up to its top', () => {
    expect(scrollTopToReveal(LIST, { top: 100, bottom: 129 }, 200)).toBe(182);
  });

  test('a margin keeps the revealed row clear of the edge fade', () => {
    // Feature flags at 826-855 sits inside the list but under its bottom fade.
    expect(scrollTopToReveal(LIST, { top: 826, bottom: 855 }, 0)).toBeNull();
    expect(scrollTopToReveal(LIST, { top: 826, bottom: 855 }, 0, 32)).toBe(32);
    expect(scrollTopToReveal(LIST, { top: 969, bottom: 998 }, 0, 32)).toBe(175);
  });

  test('a row taller than the list shows its top', () => {
    expect(scrollTopToReveal(LIST, { top: 200, bottom: 1200 }, 0)).toBe(82);
  });
});
