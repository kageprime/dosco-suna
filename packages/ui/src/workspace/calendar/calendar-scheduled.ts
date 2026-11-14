// The scheduled triggers and Loops of a workspace as calendar entries, from
// the trigger list the API already serves (`GET /triggers/all`). Pure: the
// server stores nothing for the calendar and computes nothing for it.
//
// - Upcoming fires come from the schedule (cron in its time zone, `every`
//   from the next fire, a one-off `at`), from now to the end of the window.
// - A past day shows only what really happened: the trigger's last run.
// - One trigger is one entry per day: "24 runs" for an hourly one.
import type { UnifiedTrigger, UnifiedTriggerList } from '@kortix/sdk';
import { Cron } from 'croner';
import { dayKey } from './calendar-dates';

export interface ScheduledFire {
  /** `<trigger id>:<day>`. */
  id: string;
  trigger: UnifiedTrigger;
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  /** The first fire of that day (ISO). */
  at: string;
  /** Fires that day, counted up to {@link FIRES_PER_DAY_CAP}. */
  count: number;
  capped: boolean;
  /** The trigger's last run, not a planned fire. */
  past: boolean;
  /** The last run failed. */
  failed: boolean;
}

/** Fires counted per trigger per day before the day reads "100+ runs". */
export const FIRES_PER_DAY_CAP = 100;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

/** `15m`, `4h`, `1h30m`, `2d` as seconds; null when it cannot be read. */
export function everySeconds(every: string | null | undefined): number | null {
  if (!every) return null;
  const parts = [...every.trim().toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== every.trim().toLowerCase().replace(/\s+/g, '')) return null;
  const total = parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_SECONDS[p[2]!]!, 0);
  return total > 0 ? total : null;
}

/** The fire instants of one trigger in `[from, to)`, at most `FIRES_PER_DAY_CAP + 1` per local day. */
function upcomingFires(trigger: UnifiedTrigger, from: Date, to: Date): Date[] {
  const source = trigger.source;
  if (source.at) {
    const at = new Date(source.at);
    return at >= from && at < to ? [at] : [];
  }
  const out: Date[] = [];
  const perDay = new Map<string, number>();
  const take = (at: Date): boolean => {
    const key = dayKey(at);
    const n = (perDay.get(key) ?? 0) + 1;
    perDay.set(key, n);
    if (n <= FIRES_PER_DAY_CAP + 1) out.push(at);
    return n > FIRES_PER_DAY_CAP;
  };
  const period = everySeconds(source.every);
  if (period) {
    let at = trigger.next_fire_at ? new Date(trigger.next_fire_at) : from;
    if (at < from) at = new Date(at.getTime() + Math.ceil((from.getTime() - at.getTime()) / (period * 1000)) * period * 1000);
    while (at < to) {
      // A full day: skip to the first fire of the next local day.
      if (take(at)) {
        const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
        at = new Date(at.getTime() + Math.ceil((next.getTime() - at.getTime()) / (period * 1000)) * period * 1000);
        continue;
      }
      at = new Date(at.getTime() + period * 1000);
    }
    return out;
  }
  if (!source.cron) return out;
  let cron: Cron;
  try {
    cron = new Cron(source.cron, { paused: true, timezone: source.timezone || 'UTC' });
  } catch {
    return out;
  }
  let cursor: Date | null = cron.nextRun(new Date(from.getTime() - 1));
  while (cursor && cursor < to) {
    if (take(cursor)) {
      const nextDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      cursor = cron.nextRun(new Date(nextDay.getTime() - 1));
      continue;
    }
    cursor = cron.nextRun(cursor);
  }
  return out;
}

/**
 * Every scheduled entry in `[from, to)`: one per active schedule trigger per
 * day. Nothing while the workspace's or the account's automations are paused.
 */
export function scheduledFires(list: UnifiedTriggerList | undefined, range: { from: Date; to: Date }, now: Date): ScheduledFire[] {
  if (!list || list.triggers_paused || list.account_automations_paused) return [];
  const out: ScheduledFire[] = [];
  for (const trigger of list.triggers) {
    if (trigger.source.type !== 'schedule') continue;
    const byDay = new Map<string, Date[]>();
    if (trigger.state === 'active') {
      const start = range.from > now ? range.from : now;
      for (const at of upcomingFires(trigger, start, range.to)) {
        const key = dayKey(at);
        byDay.set(key, [...(byDay.get(key) ?? []), at]);
      }
    }
    for (const [day, fires] of byDay) {
      out.push({
        id: `${trigger.id}:${day}`,
        trigger,
        day,
        at: fires[0]!.toISOString(),
        count: Math.min(fires.length, FIRES_PER_DAY_CAP),
        capped: fires.length > FIRES_PER_DAY_CAP,
        past: false,
        failed: false,
      });
    }
    const last = trigger.last_fired_at ? new Date(trigger.last_fired_at) : null;
    if (last && last >= range.from && last < range.to && last <= now) {
      const day = dayKey(last);
      if (!byDay.has(day)) {
        out.push({
          id: `${trigger.id}:${day}`,
          trigger,
          day,
          at: last.toISOString(),
          count: 1,
          capped: false,
          past: true,
          failed: trigger.last_status === 'failed' || trigger.last_status === 'error',
        });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
