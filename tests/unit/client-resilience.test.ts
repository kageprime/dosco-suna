import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Client,
  Ke2eRetryableError,
  Res,
  TransientCircuitBreaker,
  describeEdgeResponse,
  isKe2eRetryableError,
  readBreakerOptions,
  transientBreaker,
  transientRetryDelayMs,
} from '../src/core/client';
import { AssertionError } from '../src/core/expect';
import type { Captured } from '../src/core/result';

function capturedResponse(status: number, headers: Record<string, string>): Res {
  const captured: Captured = {
    routeTemplate: 'GET /v1/test',
    req: { method: 'GET', url: 'https://example.test/v1/test', headers: {} },
    res: { status, headers, bodyText: '' },
    ms: 1,
  };
  return new Res(captured);
}

function launderedMaintenance503(): Response {
  return new Response('<html>maintenance</html>', {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'retry-after': '1',
      'x-maintenance-mode': 'blocking',
    },
  });
}

beforeEach(() => {
  transientBreaker.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  transientBreaker.reset();
});

// ---------------------------------------------------------------------------
// P3.2 (a) — exponential backoff with full jitter replaces the fixed 2s delay.
// ---------------------------------------------------------------------------

describe('transient retry backoff (P3.2)', () => {
  it('grows exponentially from a ~500ms base and caps at ~8s', () => {
    const ceilings = [1, 2, 3, 4, 5, 6].map((attempt) =>
      transientRetryDelayMs(attempt, { random: () => 1 }),
    );

    expect(ceilings).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  it('applies FULL jitter — the whole window below the ceiling is reachable', () => {
    expect(transientRetryDelayMs(4, { random: () => 0 })).toBe(0);
    expect(transientRetryDelayMs(4, { random: () => 0.5 })).toBe(2_000);
    expect(transientRetryDelayMs(4, { random: () => 1 })).toBe(4_000);
  });

  it('is never the old fixed 2s for every attempt', () => {
    const fixed = [1, 2, 3].every(
      (attempt) => transientRetryDelayMs(attempt, { random: () => 0.5 }) === 2_000,
    );

    expect(fixed).toBe(false);
  });

  it('raises the floor to the edge Retry-After but never past the cap', () => {
    expect(transientRetryDelayMs(1, { retryAfterMs: 3_000, random: () => 0 })).toBe(3_000);
    expect(transientRetryDelayMs(1, { retryAfterMs: 180_000, random: () => 0 })).toBe(8_000);
  });

  it('honours the env-tunable base and cap', () => {
    expect(
      transientRetryDelayMs(3, { baseMs: 100, capMs: 1_000, random: () => 1 }),
    ).toBe(400);
    expect(
      transientRetryDelayMs(9, { baseMs: 100, capMs: 1_000, random: () => 1 }),
    ).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// P3.2 (b) — the process-wide circuit breaker.
// ---------------------------------------------------------------------------

describe('transient circuit breaker (P3.2)', () => {
  it('opens only at the threshold within the rolling window', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 3,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    breaker.record();
    expect(breaker.isOpen()).toBe(false);
    breaker.record();
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.failuresInWindow()).toBe(3);
  });

  it('closes on its own once the failures age out of the window', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 2,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    breaker.record();
    expect(breaker.isOpen()).toBe(true);

    now += 60_001;
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.failuresInWindow()).toBe(0);
  });

  it('announces exactly once per open transition', () => {
    let now = 1_000;
    const breaker = new TransientCircuitBreaker({
      threshold: 1,
      windowMs: 60_000,
      now: () => now,
    });

    breaker.record();
    expect(breaker.shouldAnnounce()).toBe(true);
    expect(breaker.shouldAnnounce()).toBe(false);

    now += 60_001;
    expect(breaker.isOpen()).toBe(false);
    breaker.record();
    expect(breaker.shouldAnnounce()).toBe(true);
  });

  it('is disabled by a non-positive threshold', () => {
    const breaker = new TransientCircuitBreaker({ threshold: 0, windowMs: 60_000 });
    for (let i = 0; i < 100; i++) breaker.record();

    expect(breaker.isOpen()).toBe(false);
  });

  it('reads env-tunable thresholds with 20-in-60s defaults', () => {
    expect(readBreakerOptions({})).toEqual({ threshold: 20, windowMs: 60_000 });
    expect(
      readBreakerOptions({ KE2E_BREAKER_THRESHOLD: '5', KE2E_BREAKER_WINDOW_MS: '10000' }),
    ).toEqual({ threshold: 5, windowMs: 10_000 });
  });

  it('stops retrying and stops marking retryable once open', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KE2E_BREAKER_THRESHOLD', '2');
    vi.resetModules();
    const mod = await import('../src/core/client');
    mod.transientBreaker.reset();

    const fetchMock = vi.fn().mockImplementation(async () => launderedMaintenance503());
    vi.stubGlobal('fetch', fetchMock);

    const client = new mod.Client('https://example.test/v1').withTransientGatewayRetries(3);
    const promise = client.get('/v1/test');
    await vi.runAllTimersAsync();
    const response = await promise;

    // Threshold 2 within the window: attempt 1 records, attempt 2 records and
    // trips the breaker, so the 4-attempt budget is cut short.
    expect(fetchMock.mock.calls.length).toBeLessThan(4);
    expect(mod.transientBreaker.isOpen()).toBe(true);

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('circuit open');
    // With the breaker open the flow-level budget must not re-amplify this.
    expect(isKe2eRetryableError(error)).toBe(false);

    mod.transientBreaker.reset();
  });

  it('still marks a laundered 503 retryable while the breaker is closed', () => {
    const response = capturedResponse(503, {
      'content-type': 'text/html',
      'retry-after': '30',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as Error).message).not.toContain('circuit open');
  });
});

// ---------------------------------------------------------------------------
// P3.3 — name the edge response instead of guessing at it.
// ---------------------------------------------------------------------------

describe('edge response diagnostics (P3.3)', () => {
  it('names a laundered edge maintenance 503 by its header pair', () => {
    expect(
      describeEdgeResponse(503, {
        'x-maintenance-mode': 'blocking',
        'retry-after': '60',
      }),
    ).toBe(
      '[edge-laundered status=503 x-maintenance-mode=blocking x-request-id=absent]',
    );
  });

  it('names a genuine application 5xx by its x-request-id', () => {
    expect(
      describeEdgeResponse(503, {
        'x-request-id': 'req-1',
        'content-type': 'application/json',
      }),
    ).toBe('[origin status=503 x-maintenance-mode=absent x-request-id=present]');
  });

  it('does not claim maintenance for an unlabelled edge failure', () => {
    expect(describeEdgeResponse(502, {})).toBe(
      '[edge status=502 x-maintenance-mode=absent x-request-id=absent]',
    );
  });

  it('puts the diagnostics in the thrown retry-classification message', () => {
    const response = capturedResponse(503, {
      'content-type': 'text/html',
      'retry-after': '30',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(200);
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain('x-maintenance-mode=blocking');
    expect((error as Error).message).toContain('x-request-id=absent');
    expect((error as Error).message).toContain('edge-laundered');
  });

  it('reports the attempt count in an exhausted network-error throw', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = new Client('https://example.test/v1')
      .withTransientGatewayRetries(2)
      .get('/v1/test');
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error.message).toContain('after 3/3 attempt(s)');
    expect(error.message).toContain('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// A failed status assert keeps what the response says (release gate
// 42666114535: the deployed smoke's only failure line was "got 503" — the
// origin classification and the body that names the cause were dropped, so
// every triage started from zero).
// ---------------------------------------------------------------------------

describe('failed status assert detail', () => {
  it('carries the origin classification and the body of a failed status assert', () => {
    const response = new Res({
      routeTemplate: 'POST /v1/projects/:projectId/sessions',
      req: { method: 'POST', url: 'https://example.test/v1/projects/p/sessions', headers: {} },
      res: {
        status: 503,
        headers: { 'x-request-id': 'req-1', 'content-type': 'application/json' },
        bodyText:
          '{"error":"The sandbox provider is at capacity right now. Try again in a minute.","code":"capacity"}',
      },
      ms: 1,
    } satisfies Captured);

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AssertionError);
    const message = (error as Error).message;
    expect(message).toContain(
      '[origin status=503 x-maintenance-mode=absent x-request-id=present]',
    );
    expect(message).toContain('body={"error":"The sandbox provider is at capacity');
    expect(message).toContain('"code":"capacity"');
  });

  it('records body=<empty> when the failed response has no body', () => {
    const response = capturedResponse(503, { 'x-request-id': 'req-1' });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain('body=<empty>');
  });

  it('a passing status assert attaches no detail', () => {
    const response = capturedResponse(201, {});
    expect(() => response.status(201)).not.toThrow();
  });
});

describe('failed status assert detail redaction (Strix CWE-532)', () => {
  it('masks a credential-shaped body before it reaches the thrown message', () => {
    // Assembled, not one literal: a JWT-shaped string in source is a gitleaks
    // generic-api-key finding, and this is a synthetic fixture.
    const header = ['eyJhbGciOiJIUzI1NiIs', 'InR5cCI6IkpXVCJ9'].join('');
    const token = [header, 'eyJzdWIiOiIxIn0', 'abc_sig'].join('.');
    const response = new Res({
      routeTemplate: 'POST /v1/projects/:projectId/sessions',
      req: { method: 'POST', url: 'https://example.test/v1/projects/p/sessions', headers: {} },
      res: {
        status: 503,
        headers: { 'x-request-id': 'req-1' },
        bodyText: JSON.stringify({ error: 'upstream refused', token }),
      },
      ms: 1,
    } satisfies Captured);

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    const message = (error as Error).message;
    expect(message).not.toContain(header);
    expect(message).toContain('***[');
  });
});

// ---------------------------------------------------------------------------
// The API's documented-retryable mirror 503 (code `git_mirror_unavailable`)
// is a proven-PRE-COMMIT retryable error: `.status()` raises the typed
// `Ke2eRetryableError` for it so the sandbox pre-build's bounded retry can
// re-send it (KRTX-4579 folded KRTX-4578's marking of the same 503 into the
// typed lane, where the origin provenance a POST re-send needs is checked).
// An opaque API 503 is still a contract failure; a mirror body without
// x-request-id is unproven and stays a hard failure. Release run
// 42666114535: the deployed smoke's warm-up session create answered this 503
// on every attempt and the hard assert failed the gate.
// ---------------------------------------------------------------------------

function capturedJsonResponse(status: number, headers: Record<string, string>, body: unknown): Res {
  const captured: Captured = {
    routeTemplate: 'POST /v1/projects/:projectId/sessions',
    req: { method: 'POST', url: 'https://example.test/v1/projects/p/sessions', headers: {} },
    res: { status, headers, bodyText: JSON.stringify(body), json: body },
    ms: 1,
  };
  return new Res(captured);
}

describe('the API mirror-unavailable 503 (run 42666114535)', () => {
  it('marks the documented code on the API 503 as proven-pre-commit retryable', () => {
    const response = capturedJsonResponse(503, {
      'content-type': 'application/json',
      'x-request-id': 'mw9k9hxr-2no',
      'retry-after': '10',
    }, { error: true, code: 'git_mirror_unavailable', message: 'git mirror is temporarily unavailable', status: 503 });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Ke2eRetryableError);
    expect(isKe2eRetryableError(error)).toBe(true);
    expect((error as { ke2eRetryAfterMs?: number }).ke2eRetryAfterMs).toBe(10_000);
    expect((error as Ke2eRetryableError).ke2ePreCommit).toBe(true);
  });

  it('keeps a mirror body without x-request-id unproven (never pre-commit)', () => {
    // Without x-request-id the body may be the edge's synthetic laundering,
    // not the origin's, so the typed pre-commit lane must never claim it.
    const response = capturedJsonResponse(503, {
      'content-type': 'application/json',
    }, { error: true, code: 'git_mirror_unavailable', status: 503 });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(false);
    expect(error).toBeInstanceOf(AssertionError);
  });

  it('keeps an opaque API 503 a hard contract failure', () => {
    const response = capturedJsonResponse(503, {
      'content-type': 'application/json',
      'x-request-id': 'mw9k9hxr-2no',
    }, { error: true, message: 'boom', status: 503 });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(false);
    expect(error).toBeInstanceOf(AssertionError);
  });

  it('keeps an API 502 with the mirror code a contract failure (only 503 carries the contract)', () => {
    const response = capturedJsonResponse(502, {
      'content-type': 'application/json',
      'x-request-id': 'mw9k9hxr-2no',
    }, { error: true, code: 'git_mirror_unavailable', status: 502 });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(false);
    expect(error).toBeInstanceOf(AssertionError);
  });

  it('keeps the proven-pre-commit mark while the breaker is open', () => {
    // The breaker's "stop marking retryable" contract governs the AMBIGUOUS
    // lane (a laundered 503 or a network failure the origin may have
    // committed — pinned above). A body-proven pre-commit 503 is the honest
    // re-send path; suppressing it while edge noise keeps the breaker open
    // would red-gate the release on a real mirror blip (the regression
    // KRTX-4579 fixes), and the pre-build's re-send is already bounded
    // (5 attempts, Retry-After honored, 15 s delay cap).
    const breakerOptions = readBreakerOptions();
    for (let i = 0; i < breakerOptions.threshold; i++) transientBreaker.record();
    expect(transientBreaker.isOpen()).toBe(true);

    const response = capturedJsonResponse(503, {
      'content-type': 'application/json',
      'x-request-id': 'mw9k9hxr-2no',
      'retry-after': '10',
    }, { error: true, code: 'git_mirror_unavailable', status: 503 });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Ke2eRetryableError);
    expect((error as Ke2eRetryableError).ke2ePreCommit).toBe(true);
    transientBreaker.reset();
  });

  it('keeps the ambiguous lane suppressible once the breaker is open', () => {
    const breakerOptions = readBreakerOptions();
    for (let i = 0; i < breakerOptions.threshold; i++) transientBreaker.record();
    expect(transientBreaker.isOpen()).toBe(true);

    const response = capturedResponse(503, {
      'content-type': 'text/html',
      'retry-after': '1',
      'x-maintenance-mode': 'blocking',
    });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain('circuit open');
    expect(isKe2eRetryableError(error)).toBe(false);
    transientBreaker.reset();
  });
});
