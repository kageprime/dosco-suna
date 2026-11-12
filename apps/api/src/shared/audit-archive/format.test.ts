import { describe, expect, test } from 'bun:test';
import {
  HOT_DAYS,
  LATE_ROW_MAX_AGE_DAYS,
  archiveObjectKey,
  decodeRows,
  encodeRows,
  isExpired,
  isReadyToArchive,
  manifestKey,
  retainUntil,
  weekEnd,
  weekStartOf,
} from './format';

const ACCOUNT = 'a7a00000-0000-4000-a000-000000000001';

describe('audit archive format', () => {
  test('weeks start on Monday 00:00 UTC', () => {
    expect(weekStartOf(new Date('2026-10-01T22:30:00Z'))).toBe('2026-09-28'); // Thursday
    expect(weekStartOf(new Date('2026-09-28T00:00:00Z'))).toBe('2026-09-28'); // Monday, first instant
    expect(weekStartOf(new Date('2026-10-04T23:59:59.999Z'))).toBe('2026-09-28'); // Sunday, last instant
    expect(weekEnd('2026-09-28').toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });

  test('keys: one object family per account and week, parts zero-padded, no-account rows apart', () => {
    expect(archiveObjectKey(ACCOUNT, '2026-09-28', 0)).toBe(`audit/${ACCOUNT}/2026/2026-09-28.000.jsonl.gz`);
    expect(archiveObjectKey(ACCOUNT, '2026-09-28', 12)).toBe(`audit/${ACCOUNT}/2026/2026-09-28.012.jsonl.gz`);
    expect(archiveObjectKey(null, '2026-09-28', 0)).toBe('audit/_none/2026/2026-09-28.000.jsonl.gz');
    expect(manifestKey('2026-09-28')).toBe('audit/_manifest/2026-09-28.json');
  });

  test('retention runs until the end of the week plus 365 days', () => {
    expect(retainUntil('2026-09-28').toISOString()).toBe('2027-10-05T00:00:00.000Z');
  });

  test('a week is ready once its END is more than HOT_DAYS (14) old, and expired once its lock would end within a day', () => {
    expect(HOT_DAYS).toBe(14);
    const end = weekEnd('2026-07-06').getTime(); // 2026-07-13
    expect(isReadyToArchive('2026-07-06', new Date(end + HOT_DAYS * 86_400_000 - 1))).toBe(false);
    expect(isReadyToArchive('2026-07-06', new Date(end + HOT_DAYS * 86_400_000 + 1))).toBe(true);
    expect(isExpired('2026-07-06', new Date(end + 363 * 86_400_000))).toBe(false);
    expect(isExpired('2026-07-06', new Date(end + 365 * 86_400_000 - 3_600_000))).toBe(true);
  });

  test('a late row no writer may add older than LATE_ROW_MAX_AGE_DAYS lands in a week the archive has not exported', () => {
    // The newest week that holds a row of that age is exported at the earliest when its end is
    // HOT_DAYS old: at least 4 days after the row was written.
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 10, 2) + hour * 3_600_000);
      const oldest = new Date(now.getTime() - LATE_ROW_MAX_AGE_DAYS * 86_400_000);
      expect(isReadyToArchive(weekStartOf(oldest), new Date(now.getTime() + 4 * 86_400_000 - 1))).toBe(false);
    }
  });

  test('rows round-trip through gzip JSONL, and equal input gives equal bytes (a retry matches the stored object)', () => {
    const rows = [{ event_id: 'a', n: 1 }, { event_id: 'b', note: 'line\nbreak "quoted"' }];
    const first = encodeRows(rows.map((r) => JSON.stringify(r)));
    const again = encodeRows(rows.map((r) => JSON.stringify(r)));
    expect(first.rows).toBe(2);
    expect(first.sha256).toHaveLength(64);
    expect(first.bytes.equals(again.bytes)).toBe(true);
    expect(decodeRows(first.bytes)).toEqual(rows);
  });
});
