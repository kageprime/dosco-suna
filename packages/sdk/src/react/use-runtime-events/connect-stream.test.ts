import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

// No-render mocks (the `hydrate-from-pending.test.ts` pattern): the connection
// policy is exercised against fakes of the two stream openers, the client
// cache and the pending hydration, so the test can assert what it opened and
// what its cleanup closed.
const state = {
  eventStreams: [] as Array<{
    opts: Record<string, unknown>;
    handle: { closed: boolean; close: () => void };
  }>,
  sessionStreams: [] as Array<{
    opts: Record<string, unknown>;
    handle: { closed: boolean; close: () => void };
  }>,
  sessionStreamClients: [] as Array<{ projectId: string; sessionId: string }>,
  hydrates: 0,
  clients: 0,
  clientThrows: false,
};

const realEventStream = await import('../../core/stream/event-stream');
mock.module('../../core/stream/event-stream', () => ({
  ...realEventStream,
  openEventStream: (opts: Record<string, unknown>) => {
    const handle = {
      closed: false,
      close: () => {
        handle.closed = true;
      },
    };
    state.eventStreams.push({ opts, handle });
    return handle;
  },
}));

const realControl = await import('../../core/session/control-stream');
mock.module('../../core/session/control-stream', () => ({
  ...realControl,
  openSessionStream: (opts: Record<string, unknown>) => {
    const handle = {
      closed: false,
      close: () => {
        handle.closed = true;
      },
    };
    state.sessionStreams.push({ opts, handle });
    return handle;
  },
  sessionStreamEventClient: (projectId: string, sessionId: string) => {
    state.sessionStreamClients.push({ projectId, sessionId });
    return { global: { event: async () => ({ stream: (async function* () {})() }) } };
  },
}));

const realClient = await import('../../core/runtime/client');
mock.module('../../core/runtime/client', () => ({
  ...realClient,
  getClient: () => {
    state.clients += 1;
    if (state.clientThrows) throw new Error('Runtime not ready');
    return { fakeRuntimeClient: true };
  },
  dropClientForUrl: () => {},
}));

const realHydrate = await import('./hydrate-core');
mock.module('./hydrate-core', () => ({
  ...realHydrate,
  hydrateFromPending: () => {
    state.hydrates += 1;
  },
}));

const { connectRuntimeStream } = await import('./connect-stream');
type ConnectRuntimeStreamDeps = import('./connect-stream').ConnectRuntimeStreamDeps;
const { createStreamRevival } = await import('./stream-revival');
const { subscribeRuntimeStream } = await import('./runtime-stream-signals');

/** A revival with fake timers, so a park's revival tick is manual. */
function revivalHarness() {
  const timers: Array<{ handler: () => void; id: number }> = [];
  let nextId = 1;
  let revives = 0;
  const revival = createStreamRevival(
    () => {
      revives += 1;
    },
    {
      reviveAfterMs: 30_000,
      setTimeout: (handler) => {
        const id = nextId++;
        timers.push({ handler, id });
        return id;
      },
      clearTimeout: (handle) => {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  );
  return {
    revival,
    revives: () => revives,
    tick: () => {
      for (const timer of timers.splice(0, timers.length)) timer.handler();
    },
  };
}

function baseDeps(overrides: Partial<ConnectRuntimeStreamDeps> = {}) {
  const harness = revivalHarness();
  return {
    deps: {
      options: { enabled: true, projectId: 'p1', sessionId: 's1' },
      wiring: {
        queryClient: new QueryClient(),
        projectId: 'p1',
        runtimeVersion: 1,
        activeServerUrl: 'http://runtime.test',
        sandboxStatus: 'connected' as const,
        runtimeHealthy: true,
        isMountRef: { current: true },
        prevRuntimeVersionRef: { current: 0 },
        prevServerUrlRef: { current: null },
        addPermission: () => {},
        removePermission: () => {},
        addQuestion: () => {},
        removeQuestion: () => {},
        clearPending: () => {},
        startCompaction: () => {},
        stopCompaction: () => {},
        applySyncEvent: () => {},
      },
      revival: harness.revival,
      streamRefs: {
        normalizeDiagnosticPaths: {
          current: <T>(m: Record<string, T[]>): Record<string, T[]> => m,
        },
        fetchLspDiagnosticsDebounced: { current: () => {} },
        markSessionAbortedLocally: { current: () => {} },
        reconcileMissingBusySessions: { current: () => {} },
      },
      ...overrides,
    },
    harness,
  };
}

beforeEach(() => {
  state.eventStreams.length = 0;
  state.sessionStreams.length = 0;
  state.sessionStreamClients.length = 0;
  state.hydrates = 0;
  state.clients = 0;
  state.clientThrows = false;
});

/** The n-th openEventStream call, failing the test when it never happened. */
function openedEventStream(n: number) {
  const entry = state.eventStreams[n];
  if (!entry) throw new Error(`expected openEventStream call #${n}`);
  return entry;
}

describe('connectRuntimeStream', () => {
  test('a gated connect opens nothing and returns no cleanup', () => {
    const { deps } = baseDeps({ options: { enabled: false } });
    expect(connectRuntimeStream(deps)).toBeUndefined();
    expect(state.eventStreams).toHaveLength(0);
    expect(state.sessionStreams).toHaveLength(0);
    expect(state.hydrates).toBe(0);
  });

  test('a connect whose client is not ready opens nothing and returns no cleanup', () => {
    // The url stores diverge briefly on a session switch; a synchronous throw
    // from getClient() is the transient "runtime not ready" state, skipped —
    // never surfaced to the global error boundary.
    state.clientThrows = true;
    const { deps } = baseDeps();
    expect(connectRuntimeStream(deps)).toBeUndefined();
    expect(state.eventStreams).toHaveLength(0);
    expect(state.sessionStreams).toHaveLength(0);
    expect(state.hydrates).toBe(0);
  });

  test('the cleanup closes BOTH streams and stops the revival timer', () => {
    const signals: string[] = [];
    const off = subscribeRuntimeStream((signal) => signals.push(signal.type));
    const { deps, harness } = baseDeps();

    const cleanup = connectRuntimeStream(deps);
    expect(cleanup).toBeFunction();
    // Hydrate runs on connect ("a revived handle has no record of the
    // previous handle's outage"), and both streams opened for (p1, s1).
    expect(state.hydrates).toBe(1);
    expect(state.sessionStreamClients).toEqual([{ projectId: 'p1', sessionId: 's1' }]);
    expect(state.sessionStreams).toHaveLength(1);
    expect(state.eventStreams).toHaveLength(1);

    // The session stream is the event source, and the shared stream owns
    // liveness: the machine's own watchdog is off for it.
    const eventStream = openedEventStream(0);
    expect(eventStream.opts.client).toBeDefined();
    expect(eventStream.opts.heartbeatTimeoutMs).toBe(24 * 60 * 60_000);

    // A park revives through the deps' revival exactly once...
    (eventStream.opts.onParked as (info: { consecutiveFailures: number }) => void)({
      consecutiveFailures: 3,
    });
    harness.tick();
    expect(harness.revives()).toBe(1);

    // ...and the cleanup closes both streams, stops the revival timer (a
    // parked revival ticks nothing afterwards) and emits the closed signal.
    if (!cleanup) throw new Error('expected a cleanup');
    cleanup();
    expect(openedEventStream(0).handle.closed).toBe(true);
    expect(state.sessionStreams[0].handle.closed).toBe(true);
    harness.tick();
    expect(harness.revives()).toBe(1);
    expect(signals.at(-1)).toBe('closed');
    off();
  });

  test('without a session the sandbox-proxy client is the event source and a gap hydrates', () => {
    const { deps } = baseDeps({ options: { enabled: true } });
    const cleanup = connectRuntimeStream(deps);
    expect(state.sessionStreamClients).toHaveLength(0);
    expect(state.sessionStreams).toHaveLength(0);
    expect(state.eventStreams).toHaveLength(1);
    const eventStream = openedEventStream(0);
    expect(eventStream.opts.client).toEqual({ fakeRuntimeClient: true });
    expect(eventStream.opts.heartbeatTimeoutMs).toBeUndefined();

    // No session stream: the machine's own gap repair re-reads what waits.
    (eventStream.opts.onGapRehydrate as () => void)();
    expect(state.hydrates).toBe(2);
    if (!cleanup) throw new Error('expected a cleanup');
    cleanup();
    expect(openedEventStream(0).handle.closed).toBe(true);
  });
});
