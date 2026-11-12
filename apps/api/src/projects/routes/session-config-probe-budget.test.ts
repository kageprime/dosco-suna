/**
 * The GET /config freshness read must never let a hung box or a slow mirror
 * hold the poller.
 *
 * KRTX-629: `readSandboxConfigState` awaited `/kortix/health` under a hard
 * 10 s `AbortSignal` and offered callers no shorter budget. A box that did
 * not answer made every freshness poll pay the full 10 s; one workspace
 * session whose daemon stopped answering health produced 18 such reads in
 * two hours and set the route's p95 at ~10000 ms while its p50 stayed flat.
 * The read edge may bound its own probe; reloads and convergences keep the
 * full budget because they act on the answer.
 *
 * KRTX-629 follow-up: the follow-up 24 h window still held 5 reads
 * ≥9.5 s — the poll bought mirror work at the 20 s acting budget
 * (`latest_etag` stages 10.8–20 s) and the probe's endpoint step, a
 * provider API call before any fetch exists to abort, was unbounded
 * (`sandbox_state` stages 9.7–11.8 s). The whole probe is bounded now, and
 * the poll's mirror stages share one poll-sized budget, each degrading to
 * its own "could not tell" value.
 *
 * The slow cases are exercised through the real route handler with
 * dependencies that genuinely hang (a db read that never settles, a mirror
 * refresh that never settles). The route case runs the real clock: its
 * probe is real I/O to a local daemon, and the budget under test is the
 * real 5 s const — fake timers corrupt that interplay (their faked stage
 * budgets fire while the probe is still in flight). The acting-caller case
 * has no real I/O and runs on fake timers. The bounded-mechanism behavior
 * for any explicitly passed budget is proven in
 * `session-reload-latest-etag-bound.test.ts`; the wiring tests beside it
 * remain a chokepoint over the route source for the probe budgets.
 */
import { describe, expect, jest, mock, test } from 'bun:test';
import type { SessionReloadDeps } from '../lib/session-reload';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

const routeSource = readFileSync(join(dirname(import.meta.path), 'session-config.ts'), 'utf8');
const reloadSource = readFileSync(join(dirname(import.meta.path), '..', 'lib', 'session-reload.ts'), 'utf8');

/** A dependency that took the request and answers nothing. */
const never = new Promise<never>(() => {});

// ── Dependencies that really hang, registered BEFORE the modules under test
// evaluate (they capture their imports then). The db answers only the
// sandbox-row read, so the probe finds an endpoint; the mirror reads the
// etag resolution makes hang, as does the mirror refresh behind the
// config-dir compare. This is the hang a slow mirror inflicts on the route;
// nothing sits between the route and it.
const SANDBOX_ROW = { externalId: 'sbx-test-1', config: { serviceKey: 'svc-key-test' } };
const realDb = await import('../../shared/db');
const { sessionSandboxes } = await import('@kortix/db');
mock.module('../../shared/db', () => ({
  ...realDb,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => (table === sessionSandboxes ? Promise.resolve([SANDBOX_ROW]) : never),
        }),
      }),
    }),
  },
}));

// The box: a real local daemon that answers health fast, so every slow case
// below isolates the MIRROR, not the probe.
const box = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () =>
    Response.json({
      agent_config_etag: 'etag-1',
      commit_sha: 'c'.repeat(40),
      config_dir_sha: 'd'.repeat(40),
      turn_in_flight: false,
    }),
});
const realIngress = await import('../../sandbox-proxy/backend');
mock.module('../../sandbox-proxy/backend', () => ({
  ...realIngress,
  // `server.url` is a URL object; the transport string-reworks it.
  resolveSandboxIngress: async () => ({ url: String(box.url), headers: {} }),
}));

const realMirror = await import('../git/mirror');
mock.module('../git/mirror', () => ({ ...realMirror, refreshMirror: () => never }));

// The runtime block is not under test; keep its manifest work out of the file.
const realDesiredRuntime = await import('../../runtime-convergence/desired');
mock.module('../../runtime-convergence/desired', () => ({
  ...realDesiredRuntime,
  computeDesiredRuntime: async () => ({
    release_id: null,
    catalog_fingerprint: null,
    daemon_build: 0,
    cli_sha256: null,
    managed_skills_hash: null,
  }),
}));

// The access gates are not under test either; answer them without the db.
const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: 'user-test',
    row: {
      accountId: ACCOUNT_ID,
      repoUrl: 'https://git.example/org/repo.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
    },
  }),
  assertProjectCapability: async () => {},
  loadVisibleSession: async () => ({
    row: { baseRef: null, agentName: null, metadata: {}, createdBy: null },
  }),
}));

const { readSandboxConfigState, latestAgentConfigEtag } = await import('../lib/session-reload');
const { projectsApp } = await import('../lib/app');
(await import('./session-config')).registerSessionConfigRoutes();

function depsWith(fetchImpl: SessionReloadDeps['fetch']): SessionReloadDeps {
  return {
    endpoint: async () => ({ baseUrl: 'http://box', headers: {} }),
    fetch: fetchImpl,
    pushGovernance: async () => ({ applied: true }),
    latestEtag: async () => 'ffff',
    sleep: async () => {},
    recordReport: async () => {},
    repairOrphanedTurn: async () => {},
  };
}

/**
 * Reject when `work` has not settled within `ms`, naming the failure mode —
 * an unbounded read fails fast instead of hanging the runner.
 */
function unbounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const sentry = new Promise<never>((_, reject) => {
    giveUp = setTimeout(() => reject(new Error(`unbounded: not settled within ${ms}ms`)), ms);
  });
  return Promise.race([work, sentry]).finally(() => clearTimeout(giveUp));
}

/**
 * Advance the fake clock toward `deadline` in 100 ms steps. Returns whether
 * `work` settled by the deadline.
 */
async function advanceUntil(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let settled = false;
  void work.finally(() => {
    settled = true;
  });
  while (!settled && Date.now() < deadline) {
    jest.advanceTimersByTime(100);
    await Promise.resolve();
  }
  return settled;
}

describe('readSandboxConfigState', () => {
  test('aborts at the caller budget, not the 10 s default, and degrades to unreachable', async () => {
    // The daemon never answers; the abort is the only exit.
    const deps = depsWith(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject((init.signal as AbortSignal).reason ?? new Error('aborted'));
          });
        }),
    );
    const startedAt = Date.now();
    const state = await readSandboxConfigState({ sessionId: SESSION_ID, timeoutMs: 1 }, deps);
    expect(state.reachable).toBe(false);
    expect(state.etag).toBeNull();
    expect(state.commitSha).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test('a healthy daemon parses without a caller budget (default stays on)', async () => {
    const deps = depsWith(async () =>
      Response.json({
        agent_config_etag: 'etag-1',
        commit_sha: 'c'.repeat(40),
        config_dir_sha: 'd'.repeat(40),
        turn_in_flight: false,
        capabilities: ['config.release.v1'],
      }),
    );
    const state = await readSandboxConfigState({ sessionId: SESSION_ID }, deps);
    expect(state.reachable).toBe(true);
    expect(state.etag).toEqual('etag-1');
    expect(state.commitSha).toEqual('c'.repeat(40));
    expect(state.configDirSha).toEqual('d'.repeat(40));
    expect(state.turnInFlight).toBe(false);
    expect(state.configReleases).toBe(true);
  });

  test('a failed probe still answers unreachable (no throw reaches the read path)', async () => {
    const deps = depsWith(async () => new Response('bad gateway', { status: 502 }));
    const state = await readSandboxConfigState({ sessionId: SESSION_ID }, deps);
    expect(state.reachable).toBe(false);
  });

  test('a hung endpoint resolution cannot outwait the probe budget', async () => {
    // The endpoint step resolves the sandbox ingress through a provider API
    // call before any fetch exists to abort. The budget must cap the WHOLE
    // probe, or a degraded provider holds the poller past the fetch's own
    // abort (KRTX-629 follow-up: 9.7-11.8 s `sandbox_state` stages).
    const deps: SessionReloadDeps = {
      ...depsWith(async () => Response.json({ agent_config_etag: 'etag-1' })),
      endpoint: () => new Promise(() => {}),
    };
    const startedAt = Date.now();
    const state = await readSandboxConfigState({ sessionId: SESSION_ID, timeoutMs: 50 }, deps);
    expect(state.reachable).toBe(false);
    expect(state.etag).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('GET /config box-health probe budget', () => {
  test('the freshness read passes the 3 s probe budget', () => {
    expect(routeSource).toContain('const SANDBOX_CONFIG_PROBE_TIMEOUT_MS = 3_000');
    expect(routeSource).toContain('readSandboxConfigState({ sessionId, timeoutMs: SANDBOX_CONFIG_PROBE_TIMEOUT_MS })');
  });

  test('the shared default stays 10 s for reloads and convergences', () => {
    expect(reloadSource).toContain('AbortSignal.timeout(input.timeoutMs ?? 10_000)');
  });
});

describe('GET /config against a slow mirror', () => {
  test(
    'the poll degrades at the shared poll budget and answers could-not-tell',
    async () => {
      // Real clock on purpose: the probe's fetch to the local box is real
      // I/O, and fake timers corrupt that interplay (their faked stage
      // budgets fire while the probe is still in flight, degrading the
      // PROBE instead of the mirror). The ~6 s here is the budget under
      // test, not an injected wait.
      const startedAt = Date.now();
      const request = unbounded(
        Promise.resolve(projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/config`)),
        12_000,
      );
      const res = await request;
      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(200);
      const body = await res.json();
      // The mirror could not answer: "could not tell", never "up to date".
      expect(body.latest_etag).toBeNull();
      expect(body.stale).toBeNull();
      // The box itself answered, so this degradation is the mirror's, not
      // the probe's.
      expect(body.sandbox_reachable).toBe(true);
      // The etag stage races the poll budget (~5 s), then the config-dir
      // stage races only what that left — its 1 s floor. A read that paid a
      // fresh budget per stage needs ~10 s; the old 20 s acting budget ~21 s
      // (the unbounded guard above ends those first).
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(9_000);
    },
    15_000,
  );

  test('the acting callers keep the full 20 s budget: still waiting at any poll-sized give-up', async () => {
    jest.useFakeTimers();
    try {
      // Reloads, turn-start convergence and admission control call
      // `latestAgentConfigEtag` with NO budget — the 20 s default. The db
      // read behind the resolution never settles here, so the budget is the
      // only exit: still waiting past 8 s (any poll-sized budget would have
      // given up), then bounded, answering null at its own budget.
      const startedAt = Date.now();
      const pending = latestAgentConfigEtag({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        baseRef: 'main',
      });
      const settledEarly = await advanceUntil(pending, startedAt + 8_000);
      expect(settledEarly).toBe(false);
      const settledAtAll = await advanceUntil(pending, startedAt + 25_000);
      expect(settledAtAll).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
