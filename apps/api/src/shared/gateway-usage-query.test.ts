/**
 * Unit tests for the pure query parser + cursor codec (no DB, no env).
 */
import { describe, expect, test } from 'bun:test';
import {
  InvalidGatewayUsageQueryError,
  USAGE_GROUP_LIMIT_DEFAULT,
  USAGE_GROUP_LIMIT_MAX,
  USAGE_DAYS_DEFAULT,
  decodeUsageCursor,
  encodeUsageCursor,
  parseGatewayUsageQuery,
} from './gateway-usage-query';

describe('parseGatewayUsageQuery', () => {
  test('no flags → rolling default window, grand total, default page size', () => {
    const q = parseGatewayUsageQuery({});
    expect(q.days).toBe(USAGE_DAYS_DEFAULT);
    expect(q.since).toBeUndefined();
    expect(q.until).toBeUndefined();
    expect(q.groupBy).toEqual([]);
    expect(q.limit).toBe(USAGE_GROUP_LIMIT_DEFAULT);
    expect(q.cursor).toBeUndefined();
  });

  test('absolute window parses since/until and drops the rolling default', () => {
    const q = parseGatewayUsageQuery({ since: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z' });
    expect(q.days).toBeUndefined();
    expect(q.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(q.until?.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  test('since after until is rejected', () => {
    expect(() => parseGatewayUsageQuery({ since: '2026-11-08', until: '2026-11-01' })).toThrow(
      InvalidGatewayUsageQueryError,
    );
  });

  test('days cannot combine with an absolute bound', () => {
    expect(() => parseGatewayUsageQuery({ days: '7', since: '2026-11-01' })).toThrow(
      /days cannot be combined/,
    );
    expect(() => parseGatewayUsageQuery({ days: '7', until: '2026-11-08' })).toThrow(
      InvalidGatewayUsageQueryError,
    );
  });

  test('a lone until is allowed (open-ended lower bound)', () => {
    const q = parseGatewayUsageQuery({ until: '2026-11-08T00:00:00Z' });
    expect(q.days).toBeUndefined();
    expect(q.since).toBeUndefined();
    expect(q.until?.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  test.each(['nope', '1.5', '0', '-3', 'NaN'])('rejects non-positive-integer days %p', (days) => {
    expect(() => parseGatewayUsageQuery({ days })).toThrow(InvalidGatewayUsageQueryError);
  });

  test.each(['not-a-date', '13/40/2026'])('rejects invalid timestamp %p', (ts) => {
    expect(() => parseGatewayUsageQuery({ since: ts })).toThrow(/Invalid since timestamp/);
  });

  test('group_by: subset validated, de-duplicated, request order preserved', () => {
    expect(parseGatewayUsageQuery({ group_by: 'source,model' }).groupBy).toEqual(['source', 'model']);
    expect(parseGatewayUsageQuery({ group_by: 'model,model,day' }).groupBy).toEqual(['model', 'day']);
    expect(parseGatewayUsageQuery({ group_by: ' model , agent ' }).groupBy).toEqual(['model', 'agent']);
    expect(parseGatewayUsageQuery({ group_by: 'model,agent,source,session,day' }).groupBy).toEqual([
      'model',
      'agent',
      'source',
      'session',
      'day',
    ]);
  });

  test('group_by rejects an unknown dimension', () => {
    expect(() => parseGatewayUsageQuery({ group_by: 'model,trigger' })).toThrow(
      /group_by must be a comma-separated subset/,
    );
  });

  test('limit clamps to [1, max] and rejects non-integers', () => {
    expect(parseGatewayUsageQuery({ limit: '50' }).limit).toBe(50);
    expect(parseGatewayUsageQuery({ limit: '999999' }).limit).toBe(USAGE_GROUP_LIMIT_MAX);
    expect(() => parseGatewayUsageQuery({ limit: '0' })).toThrow(InvalidGatewayUsageQueryError);
    expect(() => parseGatewayUsageQuery({ limit: '2.5' })).toThrow(InvalidGatewayUsageQueryError);
  });

  test('cursor round-trips through encode/decode', () => {
    const token = encodeUsageCursor({ cost: 12.34, key: 'glm-5.3-flash\u001fseo-cycle' });
    const q = parseGatewayUsageQuery({ cursor: token });
    expect(q.cursor).toEqual({ cost: 12.34, key: 'glm-5.3-flash\u001fseo-cycle' });
  });

  test.each(['', 'not-base64!!', Buffer.from('{"c":"x"}').toString('base64url'), Buffer.from('{}').toString('base64url')])(
    'a malformed cursor %p is a client error',
    (bad) => {
      // '' means "no cursor" at the route layer; decode() itself still rejects junk.
      if (bad === '') {
        expect(parseGatewayUsageQuery({ cursor: '' }).cursor).toBeUndefined();
      } else {
        expect(() => decodeUsageCursor(bad)).toThrow(InvalidGatewayUsageQueryError);
      }
    },
  );
});
