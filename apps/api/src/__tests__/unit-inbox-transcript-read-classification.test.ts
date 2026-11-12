import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The inbox transcript read fails open, and its log level follows the cause:
 * an expected stopped/gone/cold runtime state logs info ("deferred"), an
 * unexpected failure keeps its warn ("failed"). Warning on the expected states
 * was the spike KRTX-2349 files: `platinum … expose -> 409` (Platinum
 * auto-stops idle boxes) and `The operation timed out.` dominated its 156
 * warn lines in two days. The classification is `isRuntimeUnavailableError`
 * — the same one the transcript capture uses — asserted here through the
 * catch itself, not through a copy of the rule.
 */
const SESSION_ID = 'sess-inbox-classify-1';
const OC_SESSION_ID = 'oc-inbox-classify-1';

const infoLines: Array<[string, unknown]> = [];
const warnLines: Array<[string, unknown]> = [];

mock.module('../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../lib/logger', () => ({
  logger: {
    info: (message: string, context?: unknown) => infoLines.push([message, context]),
    warn: (message: string, context?: unknown) => warnLines.push([message, context]),
    error: () => undefined,
    debug: () => undefined,
  },
}));

mock.module('../shared/db', () => ({
  hasDatabase: () => true,
  withDbTransaction: async <T>(action: () => Promise<T>) => action(),
  afterDbCommit: (action: () => void) => action(),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              runtimeSessionId: OC_SESSION_ID,
              sandboxUrl: 'https://box.test/p/ext-inbox-classify/8000/',
              accountId: 'acct-1',
              projectId: 'proj-1',
              createdBy: 'user-1',
            },
          ],
        }),
      }),
    }),
  },
}));

const realRuntimeMapping = await import('../projects/runtime-session-mapping');
mock.module('../projects/runtime-session-mapping', () => ({
  ...realRuntimeMapping,
  sandboxRuntimeEndpoint: async () => ({
    url: 'https://box.test/p/ext-inbox-classify/8000',
    headers: { 'x-kortix': '1' },
  }),
}));

import { PlatinumHttpError } from '../shared/platinum';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

beforeAll(() => {
  console.warn = ((message?: unknown, ...rest: unknown[]) => {
    warnLines.push([String(message), rest[0]]);
  }) as typeof console.warn;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const row = { commandId: 'cmd-1', sessionId: SESSION_ID, actorUserId: null } as never;

async function readWithFetchThrowing(throwable: () => unknown, target = row) {
  globalThis.fetch = (async () => {
    throw throwable();
  }) as unknown as typeof fetch;
  const { readInboxTranscriptState } = await import('../projects/session-lifecycle/runtime-client');
  return readInboxTranscriptState(target, []);
}

describe('readInboxTranscriptState: the log level follows the cause', () => {
  beforeEach(() => {
    infoLines.length = 0;
    warnLines.length = 0;
  });

  test('a stopped box (the provider 409 expose answer) logs info, not warn', async () => {
    const state = await readWithFetchThrowing(
      () => new PlatinumHttpError('platinum POST /v1/sandboxes/sbx_x/expose -> 409', 409, '{"code":"sandbox_not_running"}'),
    );
    // Fails open either way — the assertion is about the LEVEL.
    expect(state.read).toBe(false);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(true);
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(false);
  });

  test('a read that overruns its budget logs info, not warn', async () => {
    const timeout = new Error('The operation timed out.');
    timeout.name = 'TimeoutError';
    await readWithFetchThrowing(() => timeout);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(true);
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(false);
  });

  test('a database failure keeps its warn', async () => {
    infoLines.length = 0;
    await readWithFetchThrowing(() => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    expect(warnLines.some(([m]) => m.includes('inbox transcript read failed'))).toBe(true);
    expect(infoLines.some(([m]) => m.includes('inbox transcript read deferred'))).toBe(false);
  });
});

describe('readInboxTranscriptState: a persistent failure warns once, not per retry attempt', () => {
  /** The 2026-11-10 outage shape: a provider 401 answer surfaced through the SDK. */
  const daytonaAuthFailure = () => Object.assign(new Error('Invalid credentials'), { name: 'DaytonaError' });
  const otherRow = { commandId: 'cmd-2', sessionId: 'sess-inbox-throttle-2', actorUserId: null } as never;

  let resetThrottle: (intervalMs?: number) => void;
  beforeAll(async () => {
    ({ __resetInboxReadWarnThrottleForTests: resetThrottle } = (await import(
      '../projects/session-lifecycle/runtime-client'
    )) as { __resetInboxReadWarnThrottleForTests(intervalMs?: number): void });
  });

  beforeEach(() => {
    infoLines.length = 0;
    warnLines.length = 0;
    resetThrottle();
  });

  test('the first unexpected failure warns', async () => {
    const state = await readWithFetchThrowing(daytonaAuthFailure);
    expect(state.read).toBe(false);
    expect(warnLines).toHaveLength(1);
  });

  test('a repeat of the same failure inside the interval stays quiet, still failing open', async () => {
    await readWithFetchThrowing(daytonaAuthFailure);
    const state = await readWithFetchThrowing(daytonaAuthFailure);
    await readWithFetchThrowing(daytonaAuthFailure);
    expect(state.read).toBe(false);
    expect(warnLines).toHaveLength(1);
  });

  test('a different error for the same session warns immediately', async () => {
    await readWithFetchThrowing(daytonaAuthFailure);
    await readWithFetchThrowing(() => new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    expect(warnLines).toHaveLength(2);
  });

  test('a different session warns independently', async () => {
    await readWithFetchThrowing(daytonaAuthFailure);
    await readWithFetchThrowing(daytonaAuthFailure, otherRow);
    expect(warnLines).toHaveLength(2);
  });

  test('the same error after the interval warns again', async () => {
    resetThrottle(10);
    await readWithFetchThrowing(daytonaAuthFailure);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await readWithFetchThrowing(daytonaAuthFailure);
    expect(warnLines).toHaveLength(2);
  });
});
