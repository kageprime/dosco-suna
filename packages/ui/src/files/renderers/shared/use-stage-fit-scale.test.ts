import { describe, expect, test } from 'bun:test';

import { fitScale } from './use-stage-fit-scale';

describe('fitScale', () => {
  test('slides fit both dimensions: the smaller ratio wins, and the stage may scale up', () => {
    // The 1920x1080 stage in a half-size container: both ratios agree at 0.5.
    expect(fitScale(960, 540, 1920, 1080, true)).toBe(0.5);
    // A taller container is width-constrained; a wider one height-constrained.
    expect(fitScale(960, 2000, 1920, 1080, true)).toBe(0.5);
    expect(fitScale(4000, 540, 1920, 1080, true)).toBe(0.5);
    // The slide arm never clamps at 1: a container wider than the stage's
    // 16:9 box fills it (the deck grows with its panel).
    expect(fitScale(3840, 2160, 1920, 1080, true)).toBe(2);
  });

  test('the desktop stage never scales up: fit clamps at 1', () => {
    // Pptx fits the width alone (no fixed stage height) and caps at 1.
    expect(fitScale(520, 600, 1040, undefined, false)).toBe(0.5);
    expect(fitScale(1040, 600, 1040, undefined, false)).toBe(1);
    expect(fitScale(2080, 1200, 1040, undefined, false)).toBe(1);
  });
});
