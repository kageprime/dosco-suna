import { describe, expect, test } from 'bun:test';

import { parseWhatsNew } from './whats-new';

const week = {
  slug: '2026-11-16',
  title: 'Shared drives',
  date: '2026-11-16T00:00:00.000Z',
  href: '/changelog/2026-11-16',
};

describe('parseWhatsNew', () => {
  test('keeps a well-formed body', () => {
    expect(parseWhatsNew({ enabled: true, weeks: [week] })).toEqual({ enabled: true, weeks: [week] });
  });

  test('turns the list off for a body that is not an object', () => {
    expect(parseWhatsNew(null)).toEqual({ enabled: false, weeks: [] });
    expect(parseWhatsNew('<html>')).toEqual({ enabled: false, weeks: [] });
  });

  test('drops a week whose link leaves the changelog', () => {
    const outside = { ...week, href: 'https://example.com/changelog/x' };
    const script = { ...week, href: 'javascript:alert(1)' };
    expect(parseWhatsNew({ enabled: true, weeks: [outside, script, week] }).weeks).toEqual([week]);
  });

  test('keeps a week without a date', () => {
    const { date: _date, ...undated } = week;
    expect(parseWhatsNew({ enabled: true, weeks: [undated] }).weeks).toEqual([undated]);
  });

  test('drops a week with a missing field or an unreadable date', () => {
    const { title: _title, ...untitled } = week;
    const misdated = { ...week, date: 'soon' };
    expect(parseWhatsNew({ enabled: true, weeks: [untitled, misdated] }).weeks).toEqual([]);
  });
});
