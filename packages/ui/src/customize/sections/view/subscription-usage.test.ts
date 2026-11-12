import { describe, expect, test } from 'bun:test';
import { accountLine, formatReset, isBlockingWindow, loginLimit, shownUsage, summarizeSubscriptions, usageTone, weeklyModel, windowLabel } from './subscription-usage';

const window = (used_percent: number) => ({ id: 'five_hour', window_minutes: 300, used_percent, resets_at: null });
const snapshot = (observed_at: string, percent: number) => ({
  windows: [window(percent)], limited: false, observed_at, source: 'response' as const,
});

describe('subscription usage meters', () => {
  test('tone: normal below 80%, amber from 80%, red from 95%, and limited only when enforced', () => {
    expect(usageTone(window(79.9), false)).toBe('ok');
    expect(usageTone(window(80), false)).toBe('near');
    expect(usageTone(window(94.9), false)).toBe('near');
    expect(usageTone(window(95), false)).toBe('critical');
    expect(usageTone(window(99.9), false)).toBe('critical');
    expect(usageTone(window(90), false)).toBe('near');
    expect(usageTone(window(100), false)).toBe('limited');
    expect(usageTone(window(95), true)).toBe('limited');
    // A refusal names the window that is full; a weekly bar at 20 % stays plain.
    expect(usageTone(window(20), true)).toBe('ok');
  });

  test('a model-specific weekly window names its model', () => {
    expect(weeklyModel('seven_day_opus')).toBe('Opus');
    expect(weeklyModel('7d_sonnet')).toBe('Sonnet');
    expect(weeklyModel('weekly')).toBeNull();
  });

  test('the newer of the live read and the listed snapshot wins', () => {
    const older = snapshot('2026-11-04T13:00:00Z', 10);
    const newer = snapshot('2026-11-04T14:00:00Z', 40);
    expect(shownUsage(newer, older)).toBe(newer);
    expect(shownUsage(older, newer)).toBe(newer);
    expect(shownUsage(null, older)).toBe(older);
    expect(shownUsage(undefined, null)).toBeNull();
  });

  test('a reset today is a clock time; within a week a weekday; later a date', () => {
    const now = Date.parse('2026-11-04T09:00:00');
    expect(formatReset('2026-11-04T16:10:00', now, 'en-GB')).toBe('16:10');
    expect(formatReset('2026-11-06T09:00:00', now, 'en-GB')).toBe('Fri 09:00');
    expect(formatReset('2026-11-20T09:00:00', now, 'en-GB')).toBe('20 Nov');
  });

  test('the account line names the email and the plan, without repeating an email the label shows', () => {
    expect(accountLine({ email: 'person@example.test', plan: 'pro' }, 'ChatGPT · Work')).toBe('person@example.test · Pro');
    expect(accountLine({ email: 'Person@Example.test', plan: 'max' }, 'Claude · person@example.test')).toBe('Max');
    expect(accountLine({ email: null, plan: null }, 'Claude')).toBeNull();
    expect(accountLine(null, 'Claude')).toBeNull();
  });
});

const NOW = Date.parse('2026-11-04T14:00:00Z');
const usage = (windows: Array<{ id: string; used_percent: number; resets_at?: string | null }>, limited = false) => ({
  windows: windows.map((w) => ({ window_minutes: null, resets_at: null, ...w })),
  limited, observed_at: '2026-11-04T13:59:00Z', source: 'usage_endpoint' as const,
});
const ok = { active: true, needs_reauth_at: null } as const;

describe('subscription summary across logins', () => {
  test('a full blocking window limits the login until it resets; a full code-review or extra-usage window does not', () => {
    expect(loginLimit(usage([{ id: 'weekly', used_percent: 100, resets_at: '2026-11-06T04:30:00.000Z' }]), NOW))
      .toEqual({ limited: true, until: '2026-11-06T04:30:00.000Z' });
    expect(loginLimit(usage([{ id: 'code_review_weekly', used_percent: 100 }, { id: 'extra_usage', used_percent: 100 }]), NOW).limited).toBe(false);
  });

  test('a window whose reset already passed limits nothing', () => {
    expect(loginLimit(usage([{ id: 'weekly', used_percent: 100, resets_at: '2026-11-04T13:00:00.000Z' }], true), NOW).limited).toBe(false);
  });

  test('two full windows: capacity is back when the later one resets', () => {
    expect(loginLimit(usage([
      { id: 'five_hour', used_percent: 100, resets_at: '2026-11-04T15:00:00.000Z' },
      { id: 'weekly', used_percent: 100, resets_at: '2026-11-06T04:30:00.000Z' },
    ]), NOW).until).toBe('2026-11-06T04:30:00.000Z');
  });

  test('counts available and limited logins, the earliest return, and the fullest window of the available ones', () => {
    const summary = summarizeSubscriptions([
      { secret: ok, usage: usage([{ id: 'five_hour', used_percent: 42 }, { id: 'weekly', used_percent: 61 }, { id: 'extra_usage', used_percent: 90 }]) },
      { secret: ok, usage: usage([{ id: 'weekly', used_percent: 100, resets_at: '2026-11-06T04:30:00.000Z' }]) },
      { secret: ok, usage: usage([{ id: 'weekly', used_percent: 100, resets_at: '2026-11-05T04:30:00.000Z' }]) },
      { secret: { ...ok, needs_reauth_at: '2026-11-01T00:00:00Z' }, usage: null },
    ], NOW);
    expect(summary).toMatchObject({ total: 4, available: 1, limited: 2, nextBack: '2026-11-05T04:30:00.000Z' });
    expect(summary.peak?.id).toBe('weekly');
  });
});

describe('unknown and model-only usage', () => {
  test('a login with no usage reported yet is neither available nor limited', () => {
    expect(summarizeSubscriptions([{ secret: ok, usage: null }, { secret: ok, usage: null }], NOW))
      .toMatchObject({ total: 2, available: 0, unknown: 2, limited: 0 });
  });

  test('extra usage alone after the plan windows reset is not availability', () => {
    expect(summarizeSubscriptions([{ secret: ok, usage: usage([
      { id: 'weekly', used_percent: 100, resets_at: '2026-11-04T13:00:00.000Z' },
      { id: 'extra_usage', used_percent: 10 },
    ]) }], NOW)).toMatchObject({ available: 0, unknown: 1 });
  });

  test('a full model window (Opus) leaves the login available; the OAuth-apps window still blocks', () => {
    expect(loginLimit(usage([{ id: 'weekly', used_percent: 30 }, { id: 'seven_day_opus', used_percent: 100 }]), NOW).limited).toBe(false);
    expect(isBlockingWindow('seven_day_oauth_apps')).toBe(true);
    expect(isBlockingWindow('7d_opus')).toBe(false);
  });
});

describe('window labels', () => {
  const t = ((key: string, values?: Record<string, string>) => ({
    fiveHour: '5-hour', weekly: 'Weekly', weeklyAll: 'Weekly · all models', extraUsage: 'Extra usage', codeReview: 'Code review', apps: 'Apps',
    weeklyModel: `Weekly · ${values?.model}`,
  } as Record<string, string>)[key] ?? key) as unknown as Parameters<typeof windowLabel>[1];
  test('every id the API writes has a readable name', () => {
    expect(windowLabel('five_hour', t)).toBe('5-hour');
    expect(windowLabel('weekly', t, { modelWeekly: true })).toBe('Weekly · all models');
    expect(windowLabel('seven_day_opus', t)).toBe('Weekly · Opus');
    expect(windowLabel('7d_sonnet', t)).toBe('Weekly · Sonnet');
    expect(windowLabel('seven_day_oauth_apps', t)).toBe('Weekly · Apps');
    expect(windowLabel('extra_usage', t)).toBe('Extra usage');
    expect(windowLabel('code_review_weekly', t)).toBe('Code review · Weekly');
    expect(windowLabel('model_gpt_5_3_codex_spark_five_hour', t)).toBe('GPT-5.3 Codex Spark · 5-hour');
  });
});
