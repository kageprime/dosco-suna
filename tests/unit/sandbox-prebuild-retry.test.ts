import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  Client,
  Ke2eRetryableError,
  isKe2eRetryableError,
  isTypedRetryableApiDegradation,
  Res,
  transientBreaker,
} from '../src/core/client';
import {
  postSessionWithRetry,
  SANDBOX_PREBUILD_CREATE_ATTEMPTS,
} from '../src/core/sandbox-prebuild';
import type { Captured } from '../src/core/result';

function capturedJson(
  status: number,
  headers: Record<string, string>,
  json: unknown,
): Res {
  const captured: Captured = {
    routeTemplate: 'POST /v1/test',
    req: { method: 'POST', url: 'https://example.test/v1/test', headers: {} },
    res: {
      status,
      headers,
      bodyText: JSON.stringify(json),
      json,
    },
    ms: 1,
  };
  return new Res(captured);
}

beforeEach(() => {
  transientBreaker.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// .status() marks the API's own typed pre-commit degradation retryable.
// ---------------------------------------------------------------------------

describe('typed retryable api degradation (Res.status)', () => {
  it('marks a git_mirror_unavailable 503 as a proven-pre-commit retryable error', () => {
    const response = capturedJson(503, { 'x-request-id': 'req-1', 'retry-after': '10' }, {
      error: true,
      code: 'git_mirror_unavailable',
      message: 'git mirror is temporarily unavailable',
      status: 503,
    });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Ke2eRetryableError);
    const retryable = error as Ke2eRetryableError;
    expect(retryable.ke2eRetryAfterMs).toBe(10_000);
    expect(retryable.ke2ePreCommit).toBe(true);
    expect(retryable.message).toContain('git_mirror_unavailable');
  });

  it('marks a retry:true 5xx (deploy in progress) as a proven-pre-commit retryable error', () => {
    const response = capturedJson(503, { 'x-request-id': 'req-2', 'retry-after': '30' }, {
      error: 'An update is in progress. Try again in a moment.',
      code: 'deploy_in_progress',
      retry: true,
    });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Ke2eRetryableError);
    const retryable = error as Ke2eRetryableError;
    expect(retryable.ke2eRetryAfterMs).toBe(30_000);
    expect(retryable.ke2ePreCommit).toBe(true);
  });

  it('does not mark an unrelated 5xx body retryable', () => {
    const response = capturedJson(500, { 'x-request-id': 'req-3' }, {
      error: 'Failed to create session',
      code: 'SESSION_CREATE_FAILED',
    });

    let error: unknown;
    try {
      response.status(201);
    } catch (caught) {
      error = caught;
    }

    expect(isKe2eRetryableError(error)).toBe(false);
  });

  it('exactly recognizes the degradation in isTypedRetryableApiDegradation', () => {
    // Provenance: only a body the origin signed (x-request-id present) can
    // prove pre-commit. The mirror contract is carried by the 503 only.
    const mirror = capturedJson(503,
      { 'x-request-id': 'req-4' }, { code: 'git_mirror_unavailable' });
    const retryFlag = capturedJson(502,
      { 'x-request-id': 'req-5' }, { retry: true });
    // Unproven shapes: without x-request-id the body may be edge laundering.
    const mirrorUnproven = capturedJson(503, {}, { code: 'git_mirror_unavailable' });
    const mirrorOnOtherStatus = capturedJson(502,
      { 'x-request-id': 'req-6' }, { code: 'git_mirror_unavailable' });
    const other = capturedJson(500,
      { 'x-request-id': 'req-7' }, { code: 'SESSION_CREATE_FAILED' });
    const ok = capturedJson(201, {}, { session_id: 's1' });

    expect(isTypedRetryableApiDegradation(mirror)).toBe(true);
    expect(isTypedRetryableApiDegradation(retryFlag)).toBe(true);
    expect(isTypedRetryableApiDegradation(mirrorUnproven)).toBe(false);
    expect(isTypedRetryableApiDegradation(mirrorOnOtherStatus)).toBe(false);
    expect(isTypedRetryableApiDegradation(other)).toBe(false);
    expect(isTypedRetryableApiDegradation(ok)).toBe(false);
  });

  it("keeps a status(201) pass a pass", () => {
    const response = capturedJson(201, {}, { session_id: 's1' });
    expect(response.status(201)).toBe(response);
  });
});

// ---------------------------------------------------------------------------
// The sandbox pre-build's bounded create retry, over a REAL Client and a
// mocked fetch so the full request path (capture -> Res -> .status() -> the
// marked class) runs exactly as the gate will.
// ---------------------------------------------------------------------------

const MIRROR_503 = {
  error: true,
  code: 'git_mirror_unavailable',
  message: 'git mirror is temporarily unavailable',
  status: 503,
};

/** A origin-typed pre-commit degradation: the API's own response body. */
function typedMirrorResponse(retryAfterSeconds = '0'): Response {
  return jsonResponse(503, { 'x-request-id': 'origin-x', 'retry-after': retryAfterSeconds }, MIRROR_503);
}

/** An edge-laundered synthetic 503: ambiguous — the origin may have committed. */
function launderedResponse(): Response {
  return jsonResponse(503, { 'retry-after': '5' }, { error: 'maintenance' });
}

function jsonResponse(status: number, headers: Record<string, string>, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('sandbox pre-build create retry (real Client, mocked fetch)', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('retries a proven pre-commit git_mirror_unavailable 503 and returns the 201', async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockImplementationOnce(async () => typedMirrorResponse())
      .mockImplementationOnce(async () =>
        jsonResponse(201, {}, { session_id: 's1' }));

    const client = new Client('https://api.test/v1');
    const promise = postSessionWithRetry(client, { id: 'p1' });
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const value = await settled as Res;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(value.statusCode).toBe(201);
    expect(value.json<{ session_id?: string }>().session_id).toBe('s1');
    expect(value.captured.req.url).toBe('https://api.test/v1/projects/p1/sessions');
  });

  it('gives up after the attempt budget and throws the last typed error', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async () => typedMirrorResponse());

    const client = new Client('https://api.test/v1');
    const promise = postSessionWithRetry(client, { id: 'p1' });
    const settled = promise.catch((err) => err as Ke2eRetryableError);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchSpy).toHaveBeenCalledTimes(SANDBOX_PREBUILD_CREATE_ATTEMPTS);
    expect(error).toBeInstanceOf(Ke2eRetryableError);
    expect(error.message).toContain('git_mirror_unavailable');
  });

  it('does NOT replay the POST when the 503 is an ambiguous laundered response', async () => {
    vi.useFakeTimers();
    // The second response is what the wrong version collapses to a duplicate
    // create: a 201 the flow would never have reached, on a POST the origin
    // may have already committed.
    fetchSpy
      .mockImplementationOnce(async () => launderedResponse())
      .mockImplementationOnce(async () =>
        jsonResponse(201, {}, { session_id: 'unexpected-duplicate' }));

    const client = new Client('https://api.test/v1');
    const promise = postSessionWithRetry(client, { id: 'p1' });
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('transient gateway status 503');
  });

  it('does NOT replay the POST after a network failure', async () => {
    vi.useFakeTimers();
    // The second response exists only to prove the re-send would have
    // "succeeded": without the guard the wrapper would loop its full budget
    // against this mock instead of stopping after the first send.
    fetchSpy
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementationOnce(async () =>
        jsonResponse(201, {}, { session_id: 'unexpected-duplicate' }));

    const client = new Client('https://api.test/v1');
    const promise = postSessionWithRetry(client, { id: 'p1' });
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('network error POST');
  });

  it('does not retry an unmarked contract failure', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async () =>
      jsonResponse(402, { 'x-request-id': 'req-5' }, { error: 'Insufficient credits' }));

    const client = new Client('https://api.test/v1');
    const promise = postSessionWithRetry(client, { id: 'p1' });
    const settled = promise.catch((err) => err as Error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('expected [201]');
  });
});
