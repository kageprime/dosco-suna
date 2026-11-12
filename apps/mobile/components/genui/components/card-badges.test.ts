import { describe, expect, test } from 'bun:test';

import { badgeWidth, cardBadgePlacement } from './card-badges';

const star = (label: string) => ({ label, star: true });
const plain = (label: string) => ({ label, star: false });

describe('cardBadgePlacement', () => {
  test('the reported case: a long badge beside a 96pt thumbnail on a 375pt phone goes above the title', () => {
    // 375 − 2 × 16 transcript − 2 × 16 card − 96 thumbnail − 12 gap = 203pt.
    expect(cardBadgePlacement({ width: 203, title: 'Jawhar outskirts', badges: [star('Nearby first choice')] })).toBe('above');
    expect(cardBadgePlacement({ width: 203, title: 'Khuri village and the Barna side', badges: [star('Desert first choice')] })).toBe('above');
  });

  test('a short badge beside a title that keeps its room stays beside, as on web', () => {
    expect(cardBadgePlacement({ width: 311, title: 'Option A', badges: [plain('New')] })).toBe('beside');
    expect(cardBadgePlacement({ width: 311, title: 'Jawhar outskirts', badges: [star('Top')] })).toBe('beside');
  });

  test('the badges as one row: two short ones together can be too wide', () => {
    expect(cardBadgePlacement({ width: 311, title: 'Taj', badges: [plain('Luxury')] })).toBe('beside');
    expect(cardBadgePlacement({ width: 311, title: 'Taj', badges: [plain('Luxury'), plain('Heritage'), plain('Sea views')] })).toBe('above');
  });

  test('a long title needs 140pt beside the badges; a short one only its own width', () => {
    // Badge 16 + 6 × 6.4 = 54.4pt; 200 − 54.4 − 12 = 133.6pt left.
    expect(cardBadgePlacement({ width: 200, title: 'A very long hotel name here', badges: [plain('Luxury')] })).toBe('above');
    expect(cardBadgePlacement({ width: 200, title: 'Taj', badges: [plain('Luxury')] })).toBe('beside');
  });

  test('large Dynamic Type widens the estimate and moves the badge above', () => {
    expect(cardBadgePlacement({ width: 311, title: 'Option A', badges: [plain('Popular')], fontScale: 1 })).toBe('beside');
    expect(cardBadgePlacement({ width: 311, title: 'Option A', badges: [plain('Popular')], fontScale: 3.1 })).toBe('above');
  });

  test('no badges is beside (nothing to place); an unmeasured column is above (never overlaps)', () => {
    expect(cardBadgePlacement({ width: 0, title: 'A', badges: [] })).toBe('beside');
    expect(cardBadgePlacement({ width: 0, title: 'A', badges: [plain('New')] })).toBe('above');
  });

  test('badgeWidth: padding, the label, the star, all scaled', () => {
    expect(badgeWidth(plain('abcde'))).toBe(16 + 32);
    expect(badgeWidth(star('abcde'))).toBe(16 + 32 + 18);
    expect(badgeWidth(plain('abcde'), 2)).toBe(16 + 64);
  });
});
