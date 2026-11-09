import type { QueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import { noteSessionSyncEvent } from '../../browser/session-sync/session-sync-registry';
import { useDiagnosticsStore } from '../../browser/stores/diagnostics-store';
import type { useRuntimePendingStore } from '../../browser/stores/runtime-pending-store';
import { noteRuntimeEvidence } from '../../browser/stores/sandbox-connection-store';
import type {
  SandboxConnectionStatus,
  useSandboxConnectionStore,
} from '../../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import { logger } from '../../core/http/logger';
import { dropClientForUrl, getClient } from '../../core/runtime/client';
import { openEventStream } from '../../core/stream/event-stream';
import { openSessionStream, sessionStreamEventClient } from '../../core/session/control-stream';
import { resetPrefetchState } from '../use-session-prefetch';
import { createEventHandler } from './handle-event';
import { resolveClientEvictionUrl } from './helpers';
import { hydrateFromPending } from './hydrate-core';
import { emitRuntimeStreamSignal } from './runtime-stream-signals';
import type { createStreamRevival } from './stream-revival';
import type { useEventStreamRefs } from './use-event-stream-refs';

/** The shared session stream has its own 45 s liveness bound. */
const SESSION_STREAM_WATCHDOG_OFF_MS = 24 * 60 * 60_000;

/** The connection options of `useRuntimeEventStream`. */
export type RuntimeEventStreamOptions = {
  enabled?: boolean;
  /**
   * Read runtime events from this session's stream (`GET .../events`, R5.3)
   * instead of the sandbox proxy's `/global/event`. `useSession` passes both.
   */
  projectId?: string;
  sessionId?: string;
  /**
   * @deprecated Ignored. Every box past the runtime floor serves its log (`runtime.log.v1`): a
   * connect or a resync reads only `GET /kortix/runtime/pending`, and no frame re-reads a
   * transcript tail or a session record.
   */
  logNative?: boolean;
};

/**
 * The store subscriptions and mount refs the connection effect reads — the
 * React wiring `useRuntimeStreamWiring` (in `index.ts`) subscribes once per
 * render, and the policy reads per run.
 */
export type RuntimeStreamWiring = {
  queryClient: QueryClient;
  /** The route-scoped project this connection's events are about. */
  projectId: string | null;
  addPermission: ReturnType<typeof useRuntimePendingStore.getState>['addPermission'];
  removePermission: ReturnType<typeof useRuntimePendingStore.getState>['removePermission'];
  addQuestion: ReturnType<typeof useRuntimePendingStore.getState>['addQuestion'];
  removeQuestion: ReturnType<typeof useRuntimePendingStore.getState>['removeQuestion'];
  clearPending: ReturnType<typeof useRuntimePendingStore.getState>['clear'];
  startCompaction: (sessionID: string) => void;
  stopCompaction: (sessionID: string) => void;
  applySyncEvent: ReturnType<typeof useSyncStore.getState>['applyEvent'];
  runtimeVersion: number;
  activeServerUrl: string | null;
  sandboxStatus: SandboxConnectionStatus;
  runtimeHealthy: boolean | null;
  isMountRef: RefObject<boolean>;
  prevRuntimeVersionRef: RefObject<number>;
  prevServerUrlRef: RefObject<string | null>;
};

/** Everything the connection policy reads, wired by `useRuntimeEventStream`. */
export type ConnectRuntimeStreamDeps = {
  options: RuntimeEventStreamOptions;
  wiring: RuntimeStreamWiring;
  revival: ReturnType<typeof createStreamRevival>;
  streamRefs: Pick<
    ReturnType<typeof useEventStreamRefs>,
    | 'normalizeDiagnosticPaths'
    | 'fetchLspDiagnosticsDebounced'
    | 'markSessionAbortedLocally'
    | 'reconcileMissingBusySessions'
  >;
};

/**
 * The connection policy of `useRuntimeEventStream`'s effect, framework-free:
 * evict stale clients, hydrate what waits, open the session (or sandbox-proxy)
 * stream, wire its callbacks, and return the cleanup. Returns `undefined`
 * when this tick must not connect (the gate, or the runtime not yet pinned).
 */
export function connectRuntimeStream(deps: ConnectRuntimeStreamDeps): (() => void) | undefined {
  const { options, wiring, revival, streamRefs } = deps;
  const {
    queryClient,
    projectId,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    clearPending,
    startCompaction,
    stopCompaction,
    applySyncEvent,
    runtimeVersion,
    activeServerUrl,
    sandboxStatus,
    runtimeHealthy,
    isMountRef,
    prevRuntimeVersionRef,
    prevServerUrlRef,
  } = wiring;
  const {
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    reconcileMissingBusySessions,
  } = streamRefs;

  // On first mount, always start clean — the provider may have remounted
  // after navigating away and back while the session's runtime changed. The
  // ref would have been initialized to the post-change runtimeVersion so the
  // isServerSwitch check below would miss the change.
  const isFirstMount = isMountRef.current;
  isMountRef.current = false;

  // Only nuke caches on an actual runtime switch (new session/sandbox), not
  // URL/port updates within the same runtime.
  const isServerSwitch = prevRuntimeVersionRef.current !== runtimeVersion;
  prevRuntimeVersionRef.current = runtimeVersion;
  const previousServerUrl = prevServerUrlRef.current;
  const didServerUrlChange = previousServerUrl !== activeServerUrl;
  prevServerUrlRef.current = activeServerUrl;

  // Only reset the SDK client on actual server switches — NOT on URL/port
  // updates. Resetting on every urlVersion change tears down the client
  // unnecessarily, causing SSE disconnection → reconnection → cache
  // invalidation cascade that manifests as random loading flashes.
  //
  // Evict ONLY the one url actually being replaced (`resolveClientEvictionUrl`)
  // — never `resetClient()`'s full `clientsByUrl` wipe, which would force
  // every OTHER concurrently-open session's client to be recreated just
  // because THIS session's runtime switched (`clientsByUrl` is deliberately
  // keyed per url so several session sandboxes stay connected at once).
  const evictUrl = resolveClientEvictionUrl({
    isFirstMount,
    isServerSwitch,
    didServerUrlChange,
    previousServerUrl,
    activeServerUrl,
  });
  if (evictUrl) dropClientForUrl(evictUrl);

  if (isFirstMount || isServerSwitch) {
    clearPending();
    // NOTE: we intentionally do NOT wipe the sync store or the runtime
    // query cache here anymore. Those are now scoped per-sandbox (see
    // runtimeKeys.activeServerKey + the sync store's session-id keying),
    // so each sandbox's data coexists safely. Wiping them was what made
    // switching back to an already-open session "reload". Diagnostics are
    // still cleared because they're keyed by bare file path (no sandbox
    // scope) and would otherwise bleed across sandboxes.
    useDiagnosticsStore.getState().clearAll();
    resetPrefetchState();
  }

  // Do not connect SSE or hydrate runtime-backed endpoints while the
  // runtime is starting/degraded. Otherwise every mounted dashboard tab
  // fans out into /session/*, /path, /permission, /question, and /lsp/*
  // requests that each sit for 30s and retry.
  if (
    options.enabled === false ||
    !activeServerUrl ||
    sandboxStatus !== 'connected' ||
    runtimeHealthy !== true
  )
    return;

  // `activeServerUrl` (getActiveServerUrl) and the url getClient() resolves
  // (getActiveRuntimeUrl → current-runtime) come from DIFFERENT accessors and
  // briefly diverge on a session switch: the server-store url is set before the
  // current-runtime url is pinned. In that window getClient() throws
  // RuntimeNotReadyError — and because this hook runs in the page render tree
  // (outside SandboxLoadingBoundary), a synchronous throw here is caught by the
  // GLOBAL error boundary and flashes the whole route to blank. "Runtime not
  // ready" is a transient info state, never an error: skip this tick and let the
  // effect re-run (deps include runtimeVersion/activeServerUrl) once it pins.
  let client: ReturnType<typeof getClient>;
  try {
    client = getClient();
  } catch {
    return;
  }

  const handleEvent = createEventHandler({
    queryClient,
    client,
    applySyncEvent,
    stopCompaction,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    normalizeDiagnosticPaths,
    markSessionAbortedLocally,
    fetchLspDiagnosticsDebounced,
    projectId,
    notificationProjectId: options.projectId ?? projectId,
    sessionId: options.projectId && options.sessionId ? options.sessionId : null,
    startCompaction,
  });

  const logSessionId = options.sessionId;
  const hydrate = () =>
    hydrateFromPending({
      applySyncEvent,
      reconcileMissingBusySessions,
      threads: () =>
        Object.keys(
          (logSessionId && useSyncStore.getState().sessionLogs[logSessionId]?.threads) || {},
        ),
      dispatch: (event) => handleEvent(event),
    });

  // A revived handle has no record of the previous handle's outage: read
  // what waits now. The session log re-reads its own page.
  hydrate();

  // Set up SSE via the framework-free event-stream machine. The
  // connect/reconnect/backoff loop, heartbeat watchdog, and event
  // coalescing all live in `openEventStream` — this wrapper only supplies
  // the QueryClient-dependent event handler and the gap-rehydrate hook.
  // R5.3: the session's own stream when the host names the session. A
  // reconnect inside the box's replay ring loses nothing, so only a runtime
  // resync re-reads; the shared stream owns liveness, so this machine's
  // watchdog stays out of it.
  const sessionStream =
    options.projectId && options.sessionId
      ? sessionStreamEventClient(options.projectId, options.sessionId)
      : null;
  // The box could not replay a gap: re-read what this view holds.
  const resyncs =
    options.projectId && options.sessionId
      ? openSessionStream({
          projectId: options.projectId,
          sessionId: options.sessionId,
          onRuntimeResync: () => hydrate(),
        })
      : null;
  const handle = openEventStream({
    client: sessionStream ?? client,
    ...(sessionStream ? { heartbeatTimeoutMs: SESSION_STREAM_WATCHDOG_OFF_MS } : {}),
    // A park is not a verdict about the sandbox — only about the last few
    // attempts. Nothing supplied this callback before, so the stream's
    // documented "terminal for this handle" silently became terminal for the
    // PAGE: the session view kept rendering a transcript nobody was updating
    // until the user reloaded. See `createStreamRevival`.
    onParked: (info) => {
      logger.warn('SSE stream parked — arming revival', {
        consecutiveFailures: info.consecutiveFailures,
      });
      revival.park();
      emitRuntimeStreamSignal({ type: 'parked' });
    },
    onEvent: (event) => {
      // Every delivered frame is live proof the runtime is reachable — it
      // vetoes concurrent health-probe failures (a loaded box can miss the
      // probe deadline mid-turn). See shouldIgnoreProbeFailure.
      noteRuntimeEvidence();
      noteSessionSyncEvent(event);
      handleEvent(event);
      emitRuntimeStreamSignal({ type: 'event', event });
    },
    onConnectionChange: (state) => emitRuntimeStreamSignal({ type: state }),
    onGapRehydrate: () => {
      if (!sessionStream) hydrate();
    },
  });

  return () => {
    revival.stop();
    resyncs?.close();
    handle.close();
    emitRuntimeStreamSignal({ type: 'closed' });
  };
}
