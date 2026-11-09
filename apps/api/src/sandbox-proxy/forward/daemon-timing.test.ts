import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { getDiagnosticFields, runWithContext } from '../../lib/request-context';
import { recordDaemonTiming, parseDaemonTiming } from './daemon-timing';

/**
 * The multi-second `/pending` rows of KRTX-4459 could never name their owner:
 * the API's `up;dur` said "one upstream op", and whether the BOX answered
 * slowly or the ingress hop ate the time was unknowable from the outside.
 * The box's own `Server-Timing` answer (`daemon;dur=…`, `lag;dur=…`) closes
 * that; these tests pin the parse, the stamping of the slow row's fields, and
 * the one wire-up line this fix installs at the transport boundary.
 */

// respondFromUpstream (the transport boundary) pulls in lifecycle side-effect
// modules; only their test-visible no-ops are needed here (see
// question-answer-close.test.ts for the same shape).
const realBackend = await import('../backend');
mock.module('../backend', () => ({ ...realBackend, markSandboxUsed: async () => undefined }));

const { respondFromUpstream } = await import('./upstream');

function proxiedRequest(): Parameters<typeof respondFromUpstream>[0] {
  return {
    sandboxId: 'ext-daemon-timing',
    port: 8000,
    access: { kind: 'principal', sandboxAuthored: true },
    method: 'GET',
    remainingPath: '/kortix/runtime/pending',
    queryString: '',
    incomingHeaders: new Headers(),
    origin: 'http://localhost:3000',
    redirectPrefix: '',
    publicOrigin: undefined,
    originMode: undefined,
    ptl: { mark: () => undefined, log: () => ({ marks: [] }) },
    record: { sessionId: '55555555-5555-4555-8555-555555555555' },
    userId: 'user-1',
    ingressRequest: { port: 8000, path: '/kortix/runtime/pending', transport: 'http' },
    upstreamPort: 8000,
    sandboxAuthored: true,
    promptDelivery: false,
    serviceKey: null,
    isSseEventStreamRequest: false,
    prefetchedIngress: null,
    promptDedupeKey: null,
    turnIdentity: null,
    turn: { accept: async () => undefined, abandon: async () => undefined },
  } as unknown as Parameters<typeof respondFromUpstream>[0];
}


describe('parseDaemonTiming', () => {
  test('reads the daemon and lag entries out of a Server-Timing header', () => {
    const parsed = parseDaemonTiming('daemon;dur=8550.2, lag;dur=1230, read;dur=1.1');
    expect(parsed).toEqual({ daemonMs: 8550, lagMs: 1230 });
  });

  test('entries in any order, with a trailing desc allowed — a future Server-Timing evolution must not silence the stamp', () => {
    expect(parseDaemonTiming('read;dur=2, daemon;dur=9, lag;dur=0')).toEqual({ daemonMs: 9, lagMs: 0 });
    expect(parseDaemonTiming('daemon;dur=5;desc="handler", lag;dur=2;desc="peak"')).toEqual({ daemonMs: 5, lagMs: 2 });
    expect(parseDaemonTiming('read;dur=2, api;dur=41')).toBeNull();
    expect(parseDaemonTiming(null)).toBeNull();
    expect(parseDaemonTiming('')).toBeNull();
  });

  test('the entry grammar refuses a negative or a non-numeric dur (it is never silently accepted)', () => {
    expect(parseDaemonTiming('daemon;dur=-3, lag;dur=0')).toBeNull();
    expect(parseDaemonTiming('daemon;dur=abc, lag;dur=0')).toBeNull();
  });
});

describe('recordDaemonTiming stamps the slow-row fields on the request context', () => {
  beforeEach(() => {
    // Fields come from the context; only what THIS call stamped must show.
    expect(getDiagnosticFields().sandbox_daemon_ms).toBeUndefined();
  });

  test('a logged row can answer box-vs-ingress from the line itself', () => {
    runWithContext('GET', '/v1/p/x/8000/kortix/runtime/pending', () => {
      recordDaemonTiming(new Headers({ 'Server-Timing': 'daemon;dur=8550, lag;dur=1230' }));
      const fields = getDiagnosticFields();
      expect(fields.sandbox_daemon_ms).toBe('8550');
      expect(fields.sandbox_loop_lag_ms).toBe('1230');
    });
  });

  test('outside a request scope it is a no-op, not a throw', () => {
    expect(() => recordDaemonTiming(new Headers({ 'Server-Timing': 'daemon;dur=5, lag;dur=1' }))).not.toThrow();
  });

  test('a proxied response flows the box stamp into the completion row (the wire-up itself, KRTX-4459)', async () => {
    await runWithContext('GET', '/v1/p/ext/8000/kortix/runtime/pending', async () => {
      const upstream = new Response('true', {
        status: 200,
        headers: { 'Server-Timing': 'daemon;dur=8460, lag;dur=915' },
      });
      const response = await respondFromUpstream(proxiedRequest(), { requestBody: undefined } as unknown as Parameters<typeof respondFromUpstream>[1], upstream, 'stall-key');
      expect(response.status).toBe(200);
      const fields = getDiagnosticFields();
      expect(fields.sandbox_daemon_ms).toBe('8460');
      expect(fields.sandbox_loop_lag_ms).toBe('915');
    });
  });
});
