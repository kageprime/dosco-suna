/**
 * The typed-503 frontend-Sentry suppression for the transient connectors
 * provider failure (`CONNECTORS_PROVIDER_UNAVAILABLE_CODE`, the mirror of
 * `apps/api/src/shared/composio-transient.ts`'s
 * `CONNECTORS_PROVIDER_UNAVAILABLE_CODE`). The API classifies a transient
 * Composio failure (its own 5xx, a dropped connection) out of ITS Sentry and
 * answers a clean 503 + Retry-After; without the `isExpectedResponse` entry
 * here the 503 crossed into the FRONTEND Sentry (app 2346967) through
 * `handleApiError` and paged a second time — the same double-paging the
 * git-mirror code fixed for its 503.
 */
import { describe, expect, test } from 'bun:test';
import { configureKortix } from './config';
import { handleErrorResponse, isReportedWriteFailure } from './response-error';
import { ApiError } from './api/errors';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const errors: unknown[] = [];

configureKortix({
  backendUrl: 'http://127.0.0.1:1',
  getToken: async () => null,
  onError: (error) => {
    errors.push(error);
  },
});

const signal = new AbortController().signal;

describe('handleErrorResponse · connectors_provider_unavailable 503', () => {
  test('the typed 503 is SILENT to onError (no frontend Sentry capture), but still returns the ApiError with its code', async () => {
    errors.length = 0;
    const result = await handleErrorResponse(
      response(503, {
        error: true,
        code: 'connectors_provider_unavailable',
        message: 'connectors provider is temporarily unavailable',
        status: 503,
      }),
      signal,
      true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).message).toBe('connectors provider is temporarily unavailable');
    expect((result.error as ApiError).code).toBe('connectors_provider_unavailable');
    // The whole point: the expected, retryable provider blip is NOT reported.
    expect(errors).toHaveLength(0);
  });

  test('a genuine 503 with another code still reports (the suppression is code-scoped)', async () => {
    errors.length = 0;
    await handleErrorResponse(
      response(503, { error: true, message: 'something else is down', status: 503 }),
      signal,
      true,
    );
    expect(errors).toHaveLength(1);
  });

  test('the git-mirror 503 stays silent (sibling behavior unchanged)', async () => {
    errors.length = 0;
    await handleErrorResponse(
      response(503, { error: true, message: 'git mirror is temporarily unavailable', status: 503 }),
      signal,
      true,
    );
    expect(errors).toHaveLength(0);
  });
});

describe('handleErrorResponse · approval expired 409', () => {
  test('the body code reaches ApiError.code, so a host can tell an expired approval apart', async () => {
    const result = await handleErrorResponse(
      response(409, { error: 'This approval expired', code: 'APPROVAL_EXPIRED' }),
      signal,
      false,
    );
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).status).toBe(409);
    expect((result.error as ApiError).code).toBe('APPROVAL_EXPIRED');
  });
});

// A write the SDK sends again reports its final failure itself
// (drives.ts uploadDriveFile): the same rule the request layer applies.
describe('isReportedWriteFailure', () => {
  test('an HTTP refusal and a dropped connection are reported', () => {
    expect(isReportedWriteFailure(new ApiError('no', { status: 403, data: { message: 'no' } }))).toBe(true);
    expect(isReportedWriteFailure(new ApiError('Failed to fetch', { name: 'TypeError' }))).toBe(true);
  });

  test('a timeout, a signed-out caller, an abort and an expected response are not', () => {
    expect(isReportedWriteFailure(new ApiError('Request timed out after 30s', { code: 'TIMEOUT' }))).toBe(false);
    expect(isReportedWriteFailure(new ApiError('Not authenticated', { code: 'NO_SESSION' }))).toBe(false);
    expect(isReportedWriteFailure(new ApiError('Request aborted', { name: 'AbortError', code: 'ABORTED' }))).toBe(false);
    const deadline = { message: 'Request exceeded the 25s server processing deadline' };
    expect(isReportedWriteFailure(new ApiError(deadline.message, { status: 503, data: deadline }))).toBe(false);
  });
});
