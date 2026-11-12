import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace } from '../domain';
import { createTraceEmitter, withFailureDetail } from './trace';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe('withFailureDetail', () => {
  test('a failure with no code or message gets both, from its HTTP status', () => {
    expect(withFailureDetail({ ok: false, status: 429 })).toMatchObject({
      errorCode: 'upstream_rate_limited',
      errorMessage: 'The provider answered HTTP 429 (rate limited) with no error message.',
    });
    expect(withFailureDetail({ ok: false, status: 503 }).errorCode).toBe('upstream_unavailable');
    expect(withFailureDetail({ ok: false, status: 401 }).errorCode).toBe('provider_key_rejected');
    expect(withFailureDetail({ ok: false, status: 402 }).errorCode).toBe('provider_payment_required');
    expect(withFailureDetail({ ok: false, status: 400 }).errorCode).toBe('upstream_error');
    expect(withFailureDetail({ ok: false, status: 0 }).errorMessage).toBe('The provider sent no response.');
  });

  test('an existing code or message is kept', () => {
    expect(withFailureDetail({ ok: false, status: 429, errorCode: 'model_busy' })).toMatchObject({
      errorCode: 'model_busy',
      errorMessage: 'The provider answered HTTP 429 (rate limited) with no error message.',
    });
    expect(withFailureDetail({ ok: false, status: 500, errorMessage: 'boom' })).toMatchObject({
      errorCode: 'upstream_unavailable',
      errorMessage: 'boom',
    });
  });

  test('a success is unchanged', () => {
    const ok = { ok: true, status: 200 };
    expect(withFailureDetail(ok)).toBe(ok);
  });
});

describe('createTraceEmitter', () => {
  test('every failed trace it records carries an error code and message', () => {
    const recorded: GatewayTrace[] = [];
    const emit = createTraceEmitter(
      { recordTrace: async (trace: GatewayTrace) => void recorded.push(trace) } as unknown as GatewayHooks,
      silent,
      'req_1',
      new Date(0).toISOString(),
      Date.now(),
    );
    emit({ status: 502, ok: false, accountId: 'acct' });
    expect(recorded[0]).toMatchObject({ errorCode: 'upstream_unavailable', errorMessage: expect.any(String) });
  });
});
