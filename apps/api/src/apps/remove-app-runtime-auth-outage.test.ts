// KRTX-4792 regression: a persistent provider auth outage (a dead/suspended
// provider org — HTTP 401 `Invalid credentials`, org `Out of credits`) used to
// surface only as per-target warn lines that page nobody. The factory watchdog
// reads Better Stack error groups (Sentry); warn logs never reach that product,
// so the 2026-11 Daytona outage ran for days before a person saw it. The fix
// escalates: the first auth-classified failure captures ONE error to Sentry
// (an error group the watchdog pages on) plus ONE error-level log line naming
// THAT provider's remediation, rate-limited to one per 15 min per process.
// The call sites are provider-agnostic (an App can host on either provider),
// so the escalation is provider-neutral: the caller passes the provider the
// failing call targeted, and a Platinum 401 never pages the Daytona
// remediation (the G9 review's repro on PR #12557).
//
// Run: pnpm --filter kortix-api test src/apps/remove-app-runtime-auth-outage.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
const errorLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];

// Do NOT import the real modules first: a module bun has already instantiated
// keeps its original instance in the ESM cache and the mock never applies
// (the capture spy would silently never fire). Hand-list the exports instead —
// lib/sentry and lib/logger export exactly these names.
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown, context?: Record<string, unknown>) => {
    captured.push({ error, context });
  },
}));
mock.module('../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLogs.push({ message, context });
    },
    localError: () => {},
    localWarn: () => {},
    flush: async (): Promise<void> => {},
  },
  isLoggingTransportError: () => false,
}));

const { removeAppRuntime } = await import('./images');
const { escalateProviderAuthOutage, __resetProviderAuthOutageForTest } = await import('../shared/provider-auth');
import type { SandboxProvider, SandboxStatus } from '../platform/providers/contract';

/**
 * A typed provider stub for `removeAppRuntime`'s resolve callback — no casts:
 * `remove`/`getStatus` are the members under test, and every other member
 * throws so an unexpected call fails loudly instead of returning undefined.
 */
function providerStub(io: {
  remove: SandboxProvider['remove'];
  getStatus: SandboxProvider['getStatus'];
}): SandboxProvider {
  const unused = (): never => {
    throw new Error('not used in this test');
  };
  return {
    name: 'daytona',
    provisioning: { async: false, stages: [] },
    create: unused,
    ensureAppRuntimeStarted: unused,
    start: unused,
    renewLifecycle: unused,
    stop: unused,
    remove: io.remove,
    getStatus: io.getStatus,
    resolveEndpoint: unused,
    routeIngress: unused,
    resolveIngress: unused,
    ensureRunning: unused,
    getProvisioningStatus: unused,
  };
}

const status = (value: SandboxStatus): SandboxProvider['getStatus'] => async () => value;

/** The SDK's real 401 shape: DaytonaAuthenticationError carries statusCode (#12549's probe). */
function daytona401(): Error {
  return Object.assign(new Error('Invalid credentials'), {
    name: 'DaytonaAuthenticationError',
    statusCode: 401,
  });
}

/** The Platinum adapter's real 401 shape: PlatinumHttpError carries .status (shared/platinum.ts). */
function platinum401(): Error {
  return Object.assign(new Error('platinum DELETE /v1/sandboxes/box-1 -> 401 {"code":"unauthorized"}'), {
    name: 'PlatinumHttpError',
    status: 401,
  });
}

/** A synthetic leaky 401: the real PlatinumHttpError message embeds the sandbox
 * path AND the upstream response body (shared/platinum.ts throws
 * `platinum <method> <path> -> <status> <body>`) — exactly the two fields that
 * must never reach the escalation telemetry (the G9 privacy review, PR #12557). */
function leakyPlatinum401(): Error {
  const body = '{"code":"unauthorized","detail":"upstream response body"}';
  return Object.assign(
    new Error(`platinum DELETE /v1/sandboxes/sbx-leaky-9876 -> 401 ${body}`),
    { name: 'PlatinumHttpError', status: 401, body },
  );
}

/** The escalated page and the log line, flattened to text for leak assertions. */
function telemetryText(event: { error: unknown; context?: Record<string, unknown> } | { message: string; context?: Record<string, unknown> }): string {
  const head = 'error' in event
    ? (event.error instanceof Error ? event.error.message : String(event.error))
    : event.message;
  return `${head} ${JSON.stringify(event.context ?? {})}`;
}

beforeEach(() => {
  captured.length = 0;
  errorLogs.length = 0;
  __resetProviderAuthOutageForTest();
});

describe('escalateProviderAuthOutage', () => {
  // A realistic wall-clock base: the reset sets last=0, so `now` must sit at
  // least one window past it for the first call to escalate.
  const T0 = 1_700_000_000_000;

  test('the first auth-classified failure captures one error and logs one error line', () => {
    const escalated = escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0);
    expect(escalated).toBe(true);
    expect(captured.length).toBe(1);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('DAYTONA_API_KEY');
    expect(event.context).toMatchObject({ action: 'app runtime removal' });
    expect(errorLogs.length).toBe(1);
    const log = errorLogs[0];
    if (!log) throw new Error('expected one error log line');
    expect(log.message).toContain('DAYTONA_API_KEY');
  });

  test("a Platinum 401 pages the PLATINUM remediation, never the Daytona one (the G9 review's repro)", () => {
    const escalated = escalateProviderAuthOutage('platinum', 'app runtime removal', platinum401(), T0);
    expect(escalated).toBe(true);
    expect(captured.length).toBe(1);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('[platinum] API rejects every call');
    expect(message).toContain('PLATINUM_API_KEY');
    expect(message).not.toContain('DAYTONA_API_KEY');
    expect(message).not.toContain('Daytona org');
    const log = errorLogs[0];
    if (!log) throw new Error('expected one error log line');
    expect(log.message).toContain('PLATINUM_API_KEY');
    expect(log.message).not.toContain('DAYTONA_API_KEY');
  });

  test('a failure inside the 15 min window does not escalate that provider again', () => {
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0)).toBe(true);
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0 + 15 * 60_000 - 1)).toBe(false);
    expect(captured.length).toBe(1);
  });

  test("one provider's window never suppresses the other provider's page (per-provider rate limit)", () => {
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0)).toBe(true);
    expect(escalateProviderAuthOutage('platinum', 'app runtime removal', platinum401(), T0 + 15 * 60_000 - 1)).toBe(true);
    expect(captured.length).toBe(2);
  });

  test("a provider that fails on every loop pass never starves the quieter provider's page (the G9 ordered-repeat probe)", () => {
    // Daytona fails on every ~5-min maintenance pass, so it re-escalates first
    // each window. Under the old shared timestamp that consumption suppressed
    // Platinum's first page forever (reviewer probe: Platinum alerts: 0).
    let escalations = 0;
    for (let t = T0; t <= T0 + 45 * 60_000; t += 15 * 60_000) {
      if (escalateProviderAuthOutage('daytona', 'orphan-box reaper list', daytona401(), t)) escalations++;
    }
    expect(escalations).toBe(4);
    expect(escalateProviderAuthOutage('platinum', 'app runtime removal', platinum401(), T0 + 20 * 60_000)).toBe(true);
    const platinumPages = captured.filter((c) =>
      c.error instanceof Error && c.error.message.includes('PLATINUM_API_KEY'));
    expect(platinumPages.length).toBe(1);
  });

  test('a failure after the window escalates again', () => {
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0)).toBe(true);
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', daytona401(), T0 + 15 * 60_000)).toBe(true);
    expect(captured.length).toBe(2);
  });

  test('a transient provider failure (502, timeout) never escalates', () => {
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', new Error('delete -> 502'), T0)).toBe(false);
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', new Error('Daytona get(x) timed out'), T0)).toBe(false);
    expect(captured.length).toBe(0);
    expect(errorLogs.length).toBe(0);
  });

  test("Daytona's org out-of-credits response is an auth outage (the 2026-11 incident's first, key-valid phase)", () => {
    const err = new Error('Out of credits. Pick a plan or top up to continue.');
    expect(escalateProviderAuthOutage('daytona', 'snapshot quota GC', err, T0)).toBe(true);
    expect(captured.length).toBe(1);
  });

  test('the escalated telemetry carries provider/action/status only — no sandbox id, no response body (the G9 privacy review)', () => {
    const escalated = escalateProviderAuthOutage('platinum', 'app runtime removal', leakyPlatinum401(), T0);
    expect(escalated).toBe(true);
    expect(captured.length).toBe(1);
    expect(errorLogs.length).toBe(1);
    const event = captured[0];
    const log = errorLogs[0];
    if (!event || !log) throw new Error('expected one captured event and one error log line');
    for (const text of [telemetryText(event), telemetryText(log)]) {
      expect(text).not.toContain('sbx-leaky-9876');
      expect(text).not.toContain('upstream response body');
      expect(text).not.toContain('DELETE /v1/sandboxes');
      expect(text).not.toContain('unauthorized');
    }
    expect(event.context).toMatchObject({ action: 'app runtime removal', status: 401 });
    expect(log.context).toMatchObject({ action: 'app runtime removal', status: 401 });
  });

  test('the org out-of-credits escalation is classified from the message but never copies it', () => {
    const escalated = escalateProviderAuthOutage(
      'daytona',
      'snapshot quota GC',
      new Error('Out of credits for org org-leaky-4321. Pick a plan or top up to continue.'),
      T0,
    );
    expect(escalated).toBe(true);
    expect(captured.length).toBe(1);
    const event = captured[0];
    const log = errorLogs[0];
    if (!event || !log) throw new Error('expected one captured event and one error log line');
    for (const text of [telemetryText(event), telemetryText(log)]) {
      expect(text).not.toContain('org-leaky-4321');
      expect(text).not.toContain('Out of credits');
    }
  });

  test('an error that merely mentions credentials without an auth status never escalates', () => {
    expect(escalateProviderAuthOutage('daytona', 'app runtime removal', new Error('cache: Invalid credentials entry'), T0)).toBe(false);
    expect(captured.length).toBe(0);
  });

  test('a provider outside the remediation map still escalates with a neutral line', () => {
    const escalated = escalateProviderAuthOutage('exotic', 'app runtime removal', daytona401(), T0);
    expect(escalated).toBe(true);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('[exotic] API rejects every call');
    expect(message).toContain('check the exotic provider credential');
  });
});

describe('removeAppRuntime escalation wire-up', () => {
  test('a Daytona 401 during App runtime teardown escalates the outage', async () => {
    const runtime = { runtimeId: 'rt-1', provider: 'daytona', externalId: 'box-1' };
    const gone = await removeAppRuntime(runtime, () => providerStub({
      remove: async () => { throw daytona401(); },
      getStatus: async () => { throw daytona401(); },
    }));
    expect(gone).toBe(false);
    expect(captured.length).toBe(1);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('DAYTONA_API_KEY');
  });

  test('a Platinum 401 at the same provider-agnostic call site pages the PLATINUM remediation', async () => {
    const runtime = { runtimeId: 'rt-2', provider: 'platinum', externalId: 'vm-1' };
    const gone = await removeAppRuntime(runtime, () => providerStub({
      remove: async () => { throw platinum401(); },
      getStatus: async () => { throw platinum401(); },
    }));
    expect(gone).toBe(false);
    expect(captured.length).toBe(1);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('PLATINUM_API_KEY');
    expect(message).not.toContain('DAYTONA_API_KEY');
  });

  test('a removal that proves the runtime gone never escalates', async () => {
    const runtime = { runtimeId: 'rt-3', provider: 'daytona', externalId: 'box-2' };
    const gone = await removeAppRuntime(runtime, () => providerStub({
      remove: async () => { throw daytona401(); },
      getStatus: status('removed'),
    }));
    expect(gone).toBe(true);
    expect(captured.length).toBe(0);
  });

  test('a plain provider 502 keeps the old behavior and never escalates', async () => {
    const runtime = { runtimeId: 'rt-4', provider: 'daytona', externalId: 'box-3' };
    const gone = await removeAppRuntime(runtime, () => providerStub({
      remove: async () => { throw new Error('DELETE -> 502'); },
      getStatus: status('running'),
    }));
    expect(gone).toBe(false);
    expect(captured.length).toBe(0);
  });
});
