import { afterEach, expect, test } from 'bun:test';

import { ApiError } from './api/errors';
import { configureKortix } from './config';
import { handleErrorResponse } from './response-error';

afterEach(() => configureKortix({ backendUrl: '', getToken: async () => null }));

for (const [status, code, expectedReports] of [
  [429, 'cost_read_busy', 0],
  [429, 'rate_limit', 1],
  [500, 'cost_read_busy', 1],
] as const) {
  test(`${status} ${code} reports ${expectedReports} global errors and preserves the caller error`, async () => {
    const reports: unknown[] = [];
    configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => null, onError: error => void reports.push(error) });
    const result = await handleErrorResponse(
      new Response(JSON.stringify({ code, message: 'Try again shortly', retry_after_seconds: 5 }), { status }),
      new AbortController().signal,
      true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    if (!(result.error instanceof ApiError)) throw new Error('Expected ApiError');
    expect(result.error.status).toBe(status);
    expect(result.error.code).toBe(code);
    expect(result.error.data).toEqual({ code, message: 'Try again shortly', retry_after_seconds: 5 });
    expect(reports).toHaveLength(expectedReports);
  });
}
