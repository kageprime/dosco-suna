import { describe, expect, test } from 'bun:test';
import type { UnifiedTrigger, UnifiedTriggerList } from '@kortix/sdk';
import { addDays, dayKey, isOverdue, itemDayKey, moveToDay, viewRange, weekStart } from './calendar-dates';
import { everySeconds, FIRES_PER_DAY_CAP, scheduledFires } from './calendar-scheduled';

const trigger = (over: Partial<UnifiedTrigger> & { source: UnifiedTrigger['source'] }): UnifiedTrigger => ({
  id: 'daily-report',
  origin: 'declared',
  name: 'Daily report',
  prompt: 'Write the report',
  agent: 'reporter',
  state: 'active',
  target: { kind: 'agent', agent: 'reporter' },
  next_fire_at: null,
  last_fired_at: null,
  last_status: null,
  last_error: null,
  ...over,
});
const list = (triggers: UnifiedTrigger[], paused = false): UnifiedTriggerList => ({ triggers, triggers_paused: paused, account_automations_paused: false, errors: [] });

// Monday 9 November 2026 to Monday 16 November, local; "now" is Wednesday noon local.
const range = { from: new Date(2026, 10, 9), to: new Date(2026, 10, 16) };
const now = new Date(2026, 10, 11, 12, 0);

describe('scheduled fires', () => {
  test('a daily cron shows once per remaining day, from now on', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fires = scheduledFires(list([trigger({ source: { type: 'schedule', cron: '0 9 * * *', timezone: tz } })]), range, now);
    // Wednesday 09:00 is past (no last run), so Thursday to Sunday remain.
    expect(fires.map((f) => f.day)).toEqual(['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(fires.every((f) => f.count === 1 && !f.past)).toBe(true);
    expect(new Date(fires[0]!.at).getHours()).toBe(9);
  });

  test('an hourly cron is one entry per day with its count', () => {
    const fires = scheduledFires(list([trigger({ source: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } })]), range, now);
    const thursday = fires.find((f) => f.day === '2026-11-12')!;
    expect(thursday.count).toBe(24);
  });

  test('a cron every minute stops counting at the cap', () => {
    const fires = scheduledFires(list([trigger({ source: { type: 'schedule', cron: '* * * * *', timezone: 'UTC' } })]), range, now);
    const thursday = fires.find((f) => f.day === '2026-11-12')!;
    expect(thursday.count).toBe(FIRES_PER_DAY_CAP);
    expect(thursday.capped).toBe(true);
    expect(fires.map((f) => f.day)).toContain('2026-11-15');
  });

  test('every: projected from the next fire; at: one fire', () => {
    const every = trigger({ id: 'reminder.1', source: { type: 'schedule', every: '1d' }, next_fire_at: new Date(2026, 10, 12, 8, 0).toISOString() });
    const once = trigger({ id: 'reminder.2', source: { type: 'schedule', at: new Date(2026, 10, 13, 17, 30).toISOString() } });
    const fires = scheduledFires(list([every, once]), range, now);
    expect(fires.filter((f) => f.trigger.id === 'reminder.1').map((f) => f.day)).toEqual(['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(fires.filter((f) => f.trigger.id === 'reminder.2').map((f) => f.day)).toEqual(['2026-11-13']);
  });

  test('a past day shows the last run only, with its outcome', () => {
    const t = trigger({ state: 'paused', source: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' }, last_fired_at: new Date(2026, 10, 10, 9, 0).toISOString(), last_status: 'failed' });
    const fires = scheduledFires(list([t]), range, now);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ day: '2026-11-10', past: true, failed: true });
  });

  test('paused automations, events and webhooks show nothing', () => {
    const cron = trigger({ source: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' } });
    expect(scheduledFires(list([cron], true), range, now)).toEqual([]);
    expect(scheduledFires(list([trigger({ source: { type: 'webhook' } })]), range, now)).toEqual([]);
    expect(scheduledFires(list([trigger({ source: { type: 'schedule', cron: 'not a cron' } })]), range, now)).toEqual([]);
  });

  test('every reads compound durations and refuses the rest', () => {
    expect(everySeconds('15m')).toBe(900);
    expect(everySeconds('1h30m')).toBe(5_400);
    expect(everySeconds('2d')).toBe(172_800);
    expect(everySeconds('soon')).toBeNull();
    expect(everySeconds('5x')).toBeNull();
  });
});

describe('calendar dates', () => {
  test('a week runs Monday to Monday; a month covers whole weeks', () => {
    expect(dayKey(weekStart(now))).toBe('2026-11-09');
    expect(viewRange('week', now)).toEqual({ from: new Date(2026, 10, 9), to: new Date(2026, 10, 16) });
    const month = viewRange('month', now);
    expect(dayKey(month.from)).toBe('2026-10-26');
    expect(dayKey(addDays(month.to, -1))).toBe('2026-12-06');
  });

  test('an all-day item keeps its date; a timed one sits on its local day', () => {
    expect(itemDayKey({ starts_at: '2026-11-16T00:00:00.000Z', all_day: true })).toBe('2026-11-16');
    const timed = new Date(2026, 10, 16, 23, 30);
    expect(itemDayKey({ starts_at: timed.toISOString(), all_day: false })).toBe('2026-11-16');
    expect(itemDayKey({ starts_at: null, all_day: false })).toBeNull();
  });

  test('moving keeps the time of day; an item with no date lands at 09:00', () => {
    const timed = new Date(2026, 10, 16, 15, 45).toISOString();
    expect(new Date(moveToDay({ starts_at: timed, all_day: false }, '2026-11-18').starts_at)).toEqual(new Date(2026, 10, 18, 15, 45));
    expect(new Date(moveToDay({ starts_at: null, all_day: false }, '2026-11-18').starts_at)).toEqual(new Date(2026, 10, 18, 9, 0));
    expect(moveToDay({ starts_at: '2026-11-16T00:00:00.000Z', all_day: true }, '2026-11-18')).toEqual({ starts_at: '2026-11-18T00:00:00.000Z', all_day: true });
  });

  test('overdue: open and past; done never is', () => {
    expect(isOverdue({ status: 'open', starts_at: new Date(2026, 10, 10).toISOString(), all_day: false }, now)).toBe(true);
    expect(isOverdue({ status: 'done', starts_at: new Date(2026, 10, 10).toISOString(), all_day: false }, now)).toBe(false);
    expect(isOverdue({ status: 'open', starts_at: '2026-11-11T00:00:00.000Z', all_day: true }, now)).toBe(false);
    expect(isOverdue({ status: 'open', starts_at: null, all_day: false }, now)).toBe(false);
  });
});
