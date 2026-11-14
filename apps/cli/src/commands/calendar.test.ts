import { describe, expect, test } from 'bun:test';
import { isoWithOffset, listWindow, parseDate, parseWhen, parseWho } from './calendar.ts';

// A fixed local moment: Saturday 14 November 2026, 13:40 local time.
const NOW = new Date(2026, 10, 14, 13, 40, 0);

describe('kortix calendar <when>', () => {
  test('an ISO time with an offset or Z is kept as that instant', () => {
    expect(parseWhen('2026-11-16T15:00:00+01:00', NOW)).toBe('2026-11-16T14:00:00.000Z');
    expect(parseWhen('2026-11-16 15:00Z', NOW)).toBe('2026-11-16T15:00:00.000Z');
    expect(parseWhen('2026-11-16T15:00+0530', NOW)).toBe('2026-11-16T09:30:00.000Z');
  });
  test('an ISO time without an offset is this machine\'s local time', () => {
    expect(parseWhen('2026-11-16T15:00', NOW)).toBe(isoWithOffset(new Date(2026, 10, 16, 15, 0)));
  });
  test('today, tomorrow and relative times', () => {
    expect(parseWhen('today 15:00', NOW)).toBe(isoWithOffset(new Date(2026, 10, 14, 15, 0)));
    expect(parseWhen('tomorrow', NOW)).toBe(isoWithOffset(new Date(2026, 10, 15, 9, 0)));
    expect(parseWhen('in 2h', NOW)).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    expect(parseWhen('+3d', NOW)).toBe(new Date(NOW.getTime() + 3 * 86_400_000).toISOString());
  });
  test('anything else is no time', () => {
    expect(parseWhen('next week', NOW)).toBeNull();
    expect(parseWhen('2026-13-45T99:00', NOW)).toBeNull();
  });
});

describe('kortix calendar --date and <who>', () => {
  test('a real date becomes UTC midnight; a wrong one is refused', () => {
    expect(parseDate('2026-11-16')).toBe('2026-11-16T00:00:00.000Z');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('16.11.2026')).toBeNull();
  });
  test('me, email, agent:<name>, a handle from the directory, else an agent name', () => {
    const directory = { people: [{ user_id: 'u-ana', name: 'Ana Lima', email: 'ana@example.test', avatar_url: null, handle: 'ana-lima' }] };
    expect(parseWho('me', directory)).toEqual({ me: true });
    expect(parseWho('ana@example.test', directory)).toEqual({ email: 'ana@example.test' });
    expect(parseWho('agent:finance', directory)).toEqual({ agent: 'finance' });
    expect(parseWho('@Ana-Lima', directory)).toEqual({ user_id: 'u-ana' });
    expect(parseWho('finance', directory)).toEqual({ agent: 'finance' });
  });
});

describe('kortix calendar ls window', () => {
  test('default: today and the next 6 days, local midnight to local midnight', () => {
    expect(listWindow({ week: false }, NOW)).toEqual({ from: new Date(2026, 10, 14).toISOString(), to: new Date(2026, 10, 21).toISOString() });
  });
  test('--week is Monday to Monday; --from/--to include the --to day', () => {
    expect(listWindow({ week: true }, NOW)).toEqual({ from: new Date(2026, 10, 9).toISOString(), to: new Date(2026, 10, 16).toISOString() });
    expect(listWindow({ week: false, from: '2026-11-01', to: '2026-11-30' }, NOW)).toEqual({
      from: new Date(2026, 10, 1).toISOString(),
      to: new Date(2026, 11, 1).toISOString(),
    });
  });
  test('a bad window is a usage error', () => {
    expect(listWindow({ week: false, days: '0' }, NOW)).toBe('--days takes 1 to 93.');
    expect(typeof listWindow({ week: false, from: 'monday' }, NOW)).toBe('string');
  });
});
