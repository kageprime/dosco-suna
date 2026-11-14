import { describe, expect, test } from 'bun:test';

import { fitHeightBelow } from './slash-menu';

describe('fitHeightBelow', () => {
  test('a menu at y 543 in a 900 px window ends 8 px above the bottom', () => {
    expect(fitHeightBelow(543, 900)).toBe(349);
  });

  test('a short window keeps a usable minimum', () => {
    expect(fitHeightBelow(700, 720)).toBe(120);
  });
});
