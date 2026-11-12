/**
 * The gateway-catalog sync's secrets read must not poll a permission denial.
 *
 * Reported 2026-11-10 (KRTX-4636): prod warned
 * `GET /v1/workspaces/:id/secrets -> 403 [HTTPException] You don't have
 * permission to perform this action (workspace.secret.read)` every 30.1 s for
 * 20 minutes — one member's dashboard, 42 warns, 17.6x the route's baseline.
 * `project.secret.read` is manager-tier, so a plain member legitimately 403s
 * this read (the comment on `listWorkspaceSecrets`), and the hook mounts the
 * read for the whole project shell the moment a sandbox connects. The
 * contract's error fail-safe kept the denied entry on its 30 s cap for the
 * life of the tab. Nothing in the hook can change the member's role, so every
 * re-ask was pure waste.
 *
 * Same harness as `contract-error-self-heal.test.ts`: the real TanStack
 * engine, the real wire, the fetch count as the observable.
 */
import { afterEach, expect, jest, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { configureKortix } from '../core/http/config';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack schedules `refetchInterval` timers only off-server, and bun tests
// run without a window — same guard as `contract-error-self-heal.test.ts`.
(globalThis as { window?: object }).window ??= {};

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useGatewayCatalogSync } = await import('./use-gateway-catalog-sync');

// A test that times out never reaches its own `finally { jest.useRealTimers() }`.
afterEach(() => {
  jest.useRealTimers();
});

/** Count requests per path so assertions name the wire, not a mock's memory. */
const counts = { secrets: 0, other: 0 };
let secretsStatus = 403;

function installFetch() {
  counts.secrets = 0;
  counts.other = 0;
  secretsStatus = 403;
  // One checked cast: Bun's `typeof fetch` carries a required `preconnect`
  // (bun.d.ts: "pass `session.fetch as typeof fetch`"), so the stub asserts the
  // signature it implements instead of bridging through `unknown`.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/secrets')) {
      counts.secrets += 1;
      if (secretsStatus === 403) {
        // The typed body the API's denial-message.ts actually sends.
        return Response.json(
          {
            error: true,
            message: "You don't have permission to perform this action (workspace.secret.read).",
            status: 403,
            code: 'forbidden',
          },
          { status: 403 },
        );
      }
      return Response.json({ error: 'server error' }, { status: secretsStatus });
    }
    counts.other += 1;
    return Response.json({});
  }) as typeof fetch;
}

/** Flush every pending microtask chain a fetch cycle leaves behind. */
const flush = async (hops = 30) => {
  for (let hop = 0; hop < hops; hop++) await Promise.resolve();
};

function connectSandbox() {
  useSandboxConnectionStore.setState({ status: 'connected', healthy: true });
}

/**
 * The reported scenario: a plain member (no `workspace.secret.read`) opens the
 * project shell with a connected sandbox. The read denies with the typed 403 —
 * a FINAL answer for this session, the role equivalent of the 404 stand-down.
 * The fail-safe must never refire: one ask, then silence while the page stays
 * mounted.
 */
test('a permission-denied secrets read stands down on the mounted shell', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  connectSandbox();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  jest.useFakeTimers();

  function Probe() {
    useGatewayCatalogSync('P1');
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });

  // The one discovery ask of the denied read.
  expect(counts.secrets).toBe(1);

  try {
    await act(async () => {
      // Far past every backoff rung (2 + 4 + 8 + 16 + 30 s) and two more cap
      // intervals: before the fix the fail-safe refired each of these, so
      // this fails with a count around 8.
      jest.advanceTimersByTime(70_000);
      await flush();
      jest.advanceTimersByTime(30_000);
      await flush();
    });
  } finally {
    jest.useRealTimers();
  }

  expect(counts.secrets).toBe(1);

  await act(async () => root?.unmount());
  client.clear();
});

/**
 * The stand-down is scoped to the permission denial. A server error on the
 * same read is still transient: the fail-safe keeps its capped backoff, which
 * is how the entry heals without a remount (KRTX-1632's dead-page shape).
 */
test('a transient server error on the same read keeps the fail-safe', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  secretsStatus = 500;
  connectSandbox();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  jest.useFakeTimers();

  function Probe() {
    useGatewayCatalogSync('P1');
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });
  const afterFirstAsk = counts.secrets;
  expect(afterFirstAsk).toBe(1);

  try {
    await act(async () => {
      // Past the 2 s and 4 s rungs: the fail-safe must have refired.
      jest.advanceTimersByTime(20_000);
      await flush();
    });
  } finally {
    jest.useRealTimers();
  }

  expect(counts.secrets).toBeGreaterThan(afterFirstAsk);

  await act(async () => root?.unmount());
  client.clear();
});
