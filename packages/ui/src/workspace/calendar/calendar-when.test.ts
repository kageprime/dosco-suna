import { describe, expect, test } from 'bun:test';
import { NO_DATE, whenLabel, whenOn } from './calendar-when';

const day = new Date(2026, 10, 19);
const local = (h: number, m = 0) => new Date(2026, 10, 19, h, m).toISOString();

describe('whenOn', () => {
  test('all day keeps the written date and has no end', () => {
    expect(whenOn(day, true, '15:00', '16:00')).toEqual({ starts_at: '2026-11-19T00:00:00.000Z', ends_at: null, all_day: true });
  });

  test('a timed item starts and ends at the local clock times', () => {
    expect(whenOn(day, false, '15:00', '16:30')).toEqual({ starts_at: local(15), ends_at: local(16, 30), all_day: false });
  });

  test('an end not after the start is dropped; no start is 09:00', () => {
    expect(whenOn(day, false, '15:00', '15:00').ends_at).toBeNull();
    expect(whenOn(day, false, '15:00', '14:00').ends_at).toBeNull();
    expect(whenOn(day, false, '').starts_at).toBe(local(9));
  });
});

describe('whenLabel', () => {
  // ICU 72+ puts a narrow no-break space before "PM".
  const label = (value: Parameters<typeof whenLabel>[0]) => whenLabel(value, 'en-US', 'No date').replace(/\u202f/g, ' ');

  test('no date, a day, a time, a range', () => {
    expect(label(NO_DATE)).toBe('No date');
    expect(label(whenOn(day, true, ''))).toBe('Thu, Nov 19');
    expect(label(whenOn(day, false, '15:00'))).toBe('Thu, Nov 19, 3:00 PM');
    expect(label(whenOn(day, false, '15:00', '16:00'))).toBe('Thu, Nov 19, 3:00 PM – 4:00 PM');
  });
});
