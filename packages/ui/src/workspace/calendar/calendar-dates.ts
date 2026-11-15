// Calendar dates in the viewer's time zone: week and month grids, day keys,
// and where an item sits. Pure; the views and the tests read these.
import type { CalendarItem } from '@kortix/sdk';

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a date: `YYYY-MM-DD`. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseDayKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Monday 00:00 local of the week that holds `d`. */
export const weekStart = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

export const weekDays = (start: Date) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

/** The weeks, Monday first, that cover the month of `d`. */
export function monthWeeks(d: Date): Date[][] {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const weeks: Date[][] = [];
  for (let s = weekStart(first); s <= last; s = addDays(s, 7)) weeks.push(weekDays(s));
  return weeks;
}

/** The window a view reads: `[from, to)` in local midnights. */
export function viewRange(mode: 'week' | 'month', anchor: Date): { from: Date; to: Date } {
  if (mode === 'week') {
    const from = weekStart(anchor);
    return { from, to: addDays(from, 7) };
  }
  const weeks = monthWeeks(anchor);
  return { from: weeks[0]![0]!, to: addDays(weeks[weeks.length - 1]![6]!, 1) };
}

/**
 * The local day an item sits on, or null with no date. An all-day item keeps
 * its calendar date in every time zone: the API stores it as UTC midnight.
 */
export function itemDayKey(item: Pick<CalendarItem, 'starts_at' | 'all_day'>): string | null {
  if (!item.starts_at) return null;
  return item.all_day ? item.starts_at.slice(0, 10) : dayKey(new Date(item.starts_at));
}

/**
 * `starts_at` and `all_day` for an item moved to another day: a timed item
 * keeps its local time of day, an all-day item stays all day, and an item
 * with no date lands at 09:00 local.
 */
export function moveToDay(item: Pick<CalendarItem, 'starts_at' | 'all_day'>, day: string): { starts_at: string; all_day: boolean } {
  if (item.all_day) return { starts_at: `${day}T00:00:00.000Z`, all_day: true };
  const target = parseDayKey(day);
  if (item.starts_at) {
    const from = new Date(item.starts_at);
    target.setHours(from.getHours(), from.getMinutes(), 0, 0);
  } else {
    target.setHours(9, 0, 0, 0);
  }
  return { starts_at: target.toISOString(), all_day: false };
}

/** An open item whose time (or, all day, whose day) has passed. */
export function isOverdue(item: Pick<CalendarItem, 'starts_at' | 'all_day' | 'status'>, now: Date): boolean {
  if (item.status !== 'open' || !item.starts_at) return false;
  if (item.all_day) return item.starts_at.slice(0, 10) < dayKey(now);
  return new Date(item.starts_at).getTime() < now.getTime();
}
