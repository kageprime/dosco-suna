import { describe, expect, test } from 'bun:test';

import { queryRetryDelay, retryAfterMs, shouldRetryQuery } from './query-retry';

const limited = (headers: Record<string, string> = {}) => ({
  status: 429,
  response: new Response(null, { status: 429, headers }),
});

describe('shouldRetryQuery', () => {
  test('a 429 is retried three times, then settles as an error', () => {
    expect(shouldRetryQuery(0, limited())).toBe(true);
    expect(shouldRetryQuery(2, limited())).toBe(true);
    expect(shouldRetryQuery(3, limited())).toBe(false);
  });

  test('every other 4xx is final', () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(shouldRetryQuery(0, { status })).toBe(false);
    }
  });

  test('a 5xx or a network failure keeps three tries', () => {
    expect(shouldRetryQuery(2, { status: 503 })).toBe(true);
    expect(shouldRetryQuery(3, { status: 503 })).toBe(false);
    expect(shouldRetryQuery(2, new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('queryRetryDelay', () => {
  const noJitter = () => 0;

  test("the API's Retry-After: 1 still waits 2 s, then 4 s, then 8 s", () => {
    const error = limited({ 'Retry-After': '1' });
    expect(retryAfterMs(error)).toBe(1_000);
    expect([0, 1, 2].map((n) => queryRetryDelay(n, error, noJitter))).toEqual([2_000, 4_000, 8_000]);
  });

  test('a longer Retry-After wins over the backoff', () => {
    expect(queryRetryDelay(0, limited({ 'Retry-After': '12' }), noJitter)).toBe(12_000);
  });

  test('without Retry-After it uses the backoff', () => {
    expect(queryRetryDelay(1, limited(), noJitter)).toBe(4_000);
  });

  test('jitter adds up to half the wait, and no wait exceeds 60 s', () => {
    expect(queryRetryDelay(0, limited({ 'Retry-After': '1' }), () => 0.999)).toBe(2_999);
    expect(queryRetryDelay(0, limited({ 'Retry-After': '600' }), noJitter)).toBe(60_000);
  });

  test('anything else keeps the default backoff', () => {
    expect(queryRetryDelay(0, { status: 503 })).toBe(1_000);
    expect(queryRetryDelay(2, { status: 503 })).toBe(4_000);
    expect(queryRetryDelay(9, { status: 503 })).toBe(30_000);
  });
});
