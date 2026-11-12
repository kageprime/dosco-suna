import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({
  config: {
    PLATINUM_API_KEY: 'pt_test',
    PLATINUM_API_URL: 'https://platinum.example.test',
    KORTIX_URL: 'https://api.example.test',
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    PLATINUM_TEMPLATE: 'kortix-computer',
  },
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.test',
}));

let fetchStatus = 404;
let fetchBody: Record<string, unknown> = { error: 'not found', code: 'not_found' };
let fetchCalls: Array<{ method: string; path: string }> = [];

beforeEach(() => {
  fetchStatus = 404;
  fetchBody = { error: 'not found', code: 'not_found' };
  fetchCalls = [];
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input);
    fetchCalls.push({ method, path });
    return new Response(JSON.stringify(fetchBody), {
      status: fetchStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

function startCallCount(): number {
  return fetchCalls.filter((call) => call.method === 'POST' && call.path.endsWith('/start')).length;
}

/** The control plane's started answer: a plain 200 whose state reads running. */
function answerStartWithRunning(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input);
    fetchCalls.push({ method, path });
    if (method === 'POST' && path.endsWith('/start')) {
      return new Response(JSON.stringify({ state: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as unknown as typeof fetch;
}

test('getStatus() reports missing Platinum sandboxes as removed', async () => {
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.getStatus('sbx_missing')).resolves.toBe('removed');
});

test('getStatus() does not read a 500 whose text says "not found" as removed', async () => {
  fetchStatus = 500;
  fetchBody = { error: 'upstream sandbox record not found in cache' };

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.getStatus('sbx_live')).resolves.toBe('unknown');
});

test('getStatus() reads the control-plane not-running verdict as stopped', async () => {
  // Platinum answers a GET for a box it has natively auto-stopped with the
  // SAME 409 sandbox_not_running its expose/exec give — there is no state
  // body. That verdict IS the stopped state, not a transitional one: the box
  // never reaches `running` without a /start, and reading it as `unknown`
  // made every wake a silent no-op while open session views polled the dead
  // box through the preview proxy (502 bursts; the box never started).
  // A box that is STARTING answers 200 with a state body instead, so this
  // branch cannot misread a boot.
  fetchStatus = 409;
  fetchBody = { error: 'sandbox not running', code: 'sandbox_not_running' };

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.getStatus('sbx_autostopped')).resolves.toBe('stopped');
});

test('ensureRunning() starts a box whose GET answers the not-running verdict', async () => {
  fetchStatus = 409;
  fetchBody = { error: 'sandbox not running', code: 'sandbox_not_running' };
  answerStartWithRunning();

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await provider.ensureRunning('sbx_autostopped');

  expect(startCallCount()).toBe(1);
});

test('ensureRunning() starts on a wake-reason verdict even when the GET says running', async () => {
  // The control plane can contradict itself: its GET answered `running` for a
  // box whose own exec refused with sandbox_not_running minutes later (one
  // prod box, over an hour). The freshest verdict wins — a wake that watched
  // the verdict MUST start the box without re-trusting the GET.
  fetchStatus = 200;
  fetchBody = { state: 'running' };
  answerStartWithRunning();

  const { PlatinumProvider } = await import('./platinum');
  const { PlatinumSandboxNotRunningError } = await import('../../shared/platinum');
  const provider = new PlatinumProvider();

  await provider.ensureRunning(
    'sbx_divergent',
    new PlatinumSandboxNotRunningError('platinum POST /v1/sandboxes/sbx_divergent/expose -> 409'),
  );

  expect(startCallCount()).toBe(1);
});

test('recoverInPlace() restores a terminal sandbox backup without changing identity', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method ?? 'GET') });
    if (String(input).endsWith('/restore-from-backup')) {
      return new Response(JSON.stringify({ id: 'sbx_data', state: 'restoring' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: 'sbx_data', state: 'failed-start', backup_state: 'completed' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_data')).resolves.toBe('recovering');
  expect(calls).toContainEqual({
    url: 'https://platinum.example.test/v1/sandboxes/sbx_data/restore-from-backup',
    method: 'POST',
  });
  expect(calls.some((call) => call.url.includes('/v1/sandboxes?'))).toBe(false);
});

test('recoverInPlace() refuses to create a replacement for an unbacked terminal sandbox', async () => {
  fetchStatus = 200;
  fetchBody = {
    id: 'sbx_unbacked',
    state: 'failed-start',
    backupState: 'none',
  };

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_unbacked')).resolves.toBe('unavailable');
});

// 2026-09-25: a Platinum reconciler race failed 17 prod starts mid-boot. Each
// box had booted before and kept its disk; answering 'unavailable' reported
// every one of those sessions lost.
test('recoverInPlace() starts a failed-start box that has booted before, in place', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(String(input)).pathname}`);
    const body =
      method === 'POST'
        ? { id: 'sbx_kept', state: 'starting' }
        : { id: 'sbx_kept', state: 'failed-start', backupState: 'none', startedAt: '2026-09-22T21:59:02Z' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_kept')).resolves.toBe('recovering');
  expect(calls).toEqual(['GET /v1/sandboxes/sbx_kept', 'POST /v1/sandboxes/sbx_kept/start']);
});

// Regression for incident 2026-08-12 (one Platinum sandbox).
//
// Platinum's reconciler deleted a sandbox that had a COMPLETED 4.87 GB backup
// in S3. From that moment `GET /v1/sandboxes/:id` returns 404 — the same 404 a
// never-existed id returns. `recoverInPlace` treated that 404 as proof of loss
// and returned 'unavailable' immediately, which made the restore branch below
// it DEAD CODE: it handles `state ∈ {failed-start,lost,deleted}` + a completed
// backup, but a tombstoned sandbox can never reach it. The one path written to
// recover exactly this case could never run.
test('recoverInPlace() still attempts a backup restore when the sandbox 404s (tombstoned)', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method ?? 'GET') });
    if (String(input).endsWith('/restore-from-backup')) {
      return new Response(JSON.stringify({ id: 'sbx_tombstoned', state: 'restoring' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // What a tombstoned row answers today.
    return new Response(JSON.stringify({ error: 'sandbox not found', code: 'sandbox_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_tombstoned')).resolves.toBe('recovering');
  expect(calls).toContainEqual({
    url: 'https://platinum.example.test/v1/sandboxes/sbx_tombstoned/restore-from-backup',
    method: 'POST',
  });
  // NEVER a create: the identity is preserved or nothing happens.
  expect(calls.some((call) => call.url.includes('/v1/sandboxes?'))).toBe(false);
});

// Platinum refuses a restore for a tombstoned row TODAY (the `sbx.deletedAt`
// guard on the endpoint). That refusal must read as "not recoverable", not as
// an exception that escapes into the caller's start path.
test('recoverInPlace() answers unavailable when the restore itself is refused', async () => {
  globalThis.fetch = (async (input) =>
    new Response(JSON.stringify({ error: 'sandbox not found', code: 'sandbox_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_gone_for_good')).resolves.toBe('unavailable');
});
