import { describe, expect, test } from 'bun:test';

import { storageBarPercent } from './account-storage';

describe('storageBarPercent', () => {
  test('scales against the largest workspace, not the limit', () => {
    expect(storageBarPercent(267_000_000, 267_000_000)).toBe(100);
    expect(storageBarPercent(133_500_000, 267_000_000)).toBe(50);
  });

  test('keeps a sliver for a real but tiny workspace', () => {
    expect(storageBarPercent(32_000, 267_000_000)).toBe(2);
  });

  test('draws nothing for an empty workspace or an empty account', () => {
    expect(storageBarPercent(0, 267_000_000)).toBe(0);
    expect(storageBarPercent(10, 0)).toBe(0);
  });
});
