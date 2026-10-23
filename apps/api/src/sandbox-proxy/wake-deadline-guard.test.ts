// `wakeSandbox` starts a box AT THE PROVIDER. The reaper stops a box at the
// provider BEFORE it writes the row, and it only ever examines rows whose
// status is 'active' — so a wake that ignores the deadline resurrects a box
// the reaper just killed, the DB heal (which does check the deadline) refuses
// to return the row to 'active', and the result is a box that is RUNNING,
// unreapable and unbilled. That is strictly worse than the zombie this design
// deletes, which is why the provider start carries the same gate as the heal.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { describe, expect, mock, test } from 'bun:test';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realKortixUserContext from '../shared/kortix-user-context';

let ensureRunningCalls: string[] = [];
let deadlineAt: Date | null = new Date(Date.now() + 60 * 60_000);

mock.module('../config', () => ({ config: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));
let providerStatusBeforeWake: 'running' | 'stopped' | 'unknown' = 'running';
const recoveryCalls: Array<Record<string, unknown>> = [];
// The ingress fake is observable so a test can prove a cached preview link is
// dropped (not merely tolerated) across the restart boundary.
let ingressResolveCalls: string[] = [];
mock.module('../projects/session-lifecycle/runtime-restart-recovery', () => ({
  recoverTurnsAfterRuntimeRestart: async (input: Record<string, unknown>) => {
    recoveryCalls.push(input);
    return { lost: [], redeliveries: [] };
  },
}));
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    async getStatus() {
      return providerStatusBeforeWake;
    },
    async ensureRunning(externalId: string) {
      ensureRunningCalls.push(externalId);
    },
    ingressCacheTtlMs: 60_000,
    async resolveIngress(externalId: string) {
      ingressResolveCalls.push(externalId);
      return {
        url: 'http://upstream.local',
        headers: { 'e2b-traffic-access-token': 'tok' },
        effectivePort: 3000,
      };
    },
  }),
}));

// Two selects run: loadSandbox (the record) then the deadline probe. Both are
// served from the same chainable stub; the deadline probe is the one that
// resolves to a row carrying `deadlineAt`.
mock.module('../shared/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      const isDeadlineProbe = 'deadlineAt' in (fields ?? {});
      const rows = isDeadlineProbe
        ? deadlineAt === null
          ? []
          : [{ deadlineAt }]
        : [
            {
              sandboxId: 'sb-1',
              externalId: 'ext-1',
              sessionId: 'sess-1',
              agentName: null,
              projectId: 'proj-1',
              accountId: 'acct-1',
              provider: 'daytona',
              status: 'stopped',
              baseUrl: null,
              config: {},
            },
          ];
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    },
  },
}));

const { wakeSandbox } = await import('./backend');

function reset(nextDeadline: Date | null) {
  ensureRunningCalls = [];
  recoveryCalls.length = 0;
  ingressResolveCalls = [];
  providerStatusBeforeWake = 'running';
  deadlineAt = nextDeadline;
}
describe('wakeSandbox — a provider start obeys the deadline', () => {
  test('wakes a box whose deadline is still live', async () => {
    reset(new Date(Date.now() + 60 * 60_000));

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual(['ext-1']);
  });

  test('a box that was STOPPED at the provider has its open turns recovered after the start', async () => {
    // SampleCo 2026-08-25 15:56: the UI woke a provider-paused box through
    // this path; the fresh runtime's first idle read then closed the killed
    // turn `completed` and its prompt was never redelivered.
    reset(new Date(Date.now() + 60 * 60_000));
    providerStatusBeforeWake = 'stopped';

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual(['ext-1']);
    expect(recoveryCalls).toEqual([
      { sandboxId: 'sb-1', sessionId: 'sess-1', externalId: 'ext-1', hold: false },
    ]);
  });

  test('a box that was already running is not treated as a restart', async () => {
    reset(new Date(Date.now() + 60 * 60_000));
    providerStatusBeforeWake = 'running';

    await wakeSandbox('ext-1');

    expect(recoveryCalls).toEqual([]);
  });

  test('a restart drops every cached preview link so the next resolve re-mints the token', async () => {
    // The restart mints a NEW provider ingress credential (E2B rotates the
    // traffic token on every resume). A link cached before the restart would
    // replay the dead one — the resolve after the wake must go to the provider
    // again, not to the cache.
    reset(new Date(Date.now() + 60 * 60_000));
    providerStatusBeforeWake = 'stopped';
    const backend = await import('./backend');
    // The module-internal link cache outlives the fake rows a test seeds, so
    // each of these tests starts from an empty one.
    backend.invalidateSandboxPreviewLinks('ext-1');
    const ref = { externalId: 'ext-1', provider: 'daytona' };
    const request = { port: 3000, path: '/', transport: 'http' as const };

    await backend.resolveSandboxIngress(ref, request);
    await backend.resolveSandboxIngress(ref, request); // served by the cache
    expect(ingressResolveCalls).toEqual(['ext-1']);

    await wakeSandbox('ext-1');

    await backend.resolveSandboxIngress(ref, request);
    expect(ingressResolveCalls).toEqual(['ext-1', 'ext-1']);
  });

  test('a wake that was already running does not drop cached preview links', async () => {
    reset(new Date(Date.now() + 60 * 60_000));
    providerStatusBeforeWake = 'running';
    const backend = await import('./backend');
    backend.invalidateSandboxPreviewLinks('ext-1');
    const ref = { externalId: 'ext-1', provider: 'daytona' };
    const request = { port: 3000, path: '/', transport: 'http' as const };

    await backend.resolveSandboxIngress(ref, request);
    await wakeSandbox('ext-1');
    await backend.resolveSandboxIngress(ref, request);
    expect(ingressResolveCalls).toEqual(['ext-1']);
  });

  test('REFUSES to wake a box whose deadline has passed', async () => {
    // A reaper-stopped box has an expired deadline by construction. Starting it
    // here would leave it running at the provider while the row stays 'stopped'
    // — invisible to the reaper, whose candidate set is status='active' only.
    reset(new Date(Date.now() - 60_000));

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual([]);
  });

  test('refuses when the deadline row cannot be read, rather than failing open', async () => {
    reset(null);

    await wakeSandbox('ext-1');

    expect(ensureRunningCalls).toEqual([]);
  });
});
