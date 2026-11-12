import { describe, expect, mock, test } from 'bun:test';

import { formatIsoDate, formatShortDate } from './plan-status';

/**
 * Characterization: the two ISO date formatters of the plan-status
 * vocabulary, pinned before they moved here from `plan-card.tsx` and
 * `account-overview.tsx`. Empty and invalid input return null — the caller
 * decides the fallback — and a real date renders month-short/day-numeric,
 * with the year only in `formatIsoDate`. Expected strings are computed with
 * the same Intl call the formatter makes so the pin does not depend on the
 * test run's timezone.
 */
describe('formatShortDate / formatIsoDate', () => {
  test('empty input renders null, for both formatters', () => {
    expect(formatShortDate(null)).toBeNull();
    expect(formatShortDate(undefined)).toBeNull();
    expect(formatShortDate('')).toBeNull();
    expect(formatIsoDate(null)).toBeNull();
    expect(formatIsoDate(undefined)).toBeNull();
    expect(formatIsoDate('')).toBeNull();
  });

  test('invalid input renders null, never "Invalid Date"', () => {
    expect(formatShortDate('not-a-date')).toBeNull();
    expect(formatIsoDate('not-a-date')).toBeNull();
  });

  test('a real date renders month-short/day-numeric; the year only in formatIsoDate', () => {
    const iso = '2026-11-14T00:00:00.000Z';
    expect(formatShortDate(iso, 'en-US')).toBe(
      new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    );
    expect(formatIsoDate(iso, 'en-US')).toBe(
      new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    );
  });

  test('an omitted locale renders in the runtime default locale', () => {
    const iso = '2026-11-14T00:00:00.000Z';
    expect(formatShortDate(iso)).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
    expect(formatIsoDate(iso)).toBe(
      new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    );
  });
});

/**
 * The `statuses.<status>` fallback of the shared copy hook: a status the
 * catalog translates reads the catalog key; an unknown Stripe status falls
 * back to the `status` template with the snake_case read as words.
 */
describe('usePlanStatusCopy', () => {
  test('a translated status reads the catalog, an unknown one falls back to words', async () => {
    const t = Object.assign(
      (key: string, params?: Record<string, unknown>) =>
        params ? `${key}[${JSON.stringify(params)}]` : key,
      { has: (key: string) => key === 'statuses.past_due' },
    );
    mock.module('@/i18n/use-translations', () => ({
      useTranslations: () => t,
      useLocale: () => 'en-US',
    }));
    const { usePlanStatusCopy } = await import('./plan-status');
    const copy = usePlanStatusCopy();
    expect(copy.status('past_due')).toBe('statuses.past_due');
    expect(copy.status('incomplete_expired')).toBe(
      'status[{"status":"incomplete expired"}]',
    );
  });
});
