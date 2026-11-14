import { describe, expect, test } from 'bun:test';
import { featureShown } from '../feature-flags.ts';

describe('featureShown', () => {
  test('a flagged item shows only with its flag', () => {
    expect(featureShown('apps', new Set(['apps']))).toBe(true);
    expect(featureShown('apps', new Set())).toBe(false);
    expect(featureShown(undefined, null)).toBe(true);
  });

  test('`kortix goals` shows in a goal_mode box without the goals flag: a chat binds its own goal', () => {
    expect(featureShown('goals', new Set(['goal_mode']))).toBe(true);
    expect(featureShown('goals', new Set(['drives']))).toBe(false);
    expect(featureShown('goals', null)).toBe(false);
  });
});
