import { describe, expect, test } from 'bun:test';
import { keptUnderBudget } from './session-log-read';

/** Rows the read would probe, newest first (`seq` descending), each with its stored size in bytes. */
const rowsOf = (...bytes: number[]): { seq: number; bytes: number }[] => bytes.map((bytes, at) => ({ seq: 1000 - at, bytes }));

describe('keptUnderBudget', () => {
  test('a window under the budget keeps every row and drops nothing', () => {
    const kept = keptUnderBudget(rowsOf(10, 20, 30), 1_000);
    expect(kept.keptCount).toBe(3);
    expect(kept.oldestKeptSeq).toBeNull();
    expect(kept.dropped).toBe(false);
  });

  test('an overflowing window keeps the newest run and drops the older tail', () => {
    const kept = keptUnderBudget(rowsOf(10, 10, 10, 10), 30);
    expect(kept.keptCount).toBe(3);
    expect(kept.oldestKeptSeq).toBe(998);
    expect(kept.dropped).toBe(true);
  });

  test('the newest message is served however large it is', () => {
    const kept = keptUnderBudget(rowsOf(5_000, 10, 10), 1_000);
    expect(kept.keptCount).toBe(1);
    expect(kept.oldestKeptSeq).toBe(1000);
    expect(kept.dropped).toBe(true);
  });

  test('exact sums at the budget keep the row', () => {
    const kept = keptUnderBudget(rowsOf(10, 10, 10), 30);
    expect(kept.keptCount).toBe(3);
    expect(kept.dropped).toBe(false);
  });

  test('an empty window drops nothing', () => {
    const kept = keptUnderBudget([], 1_000);
    expect(kept).toEqual({ keptCount: 0, oldestKeptSeq: null, dropped: false });
  });
});
