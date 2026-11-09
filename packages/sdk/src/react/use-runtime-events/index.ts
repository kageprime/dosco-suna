'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRuntimeCompactionStore } from '../../browser/stores/runtime-compaction-store';
import { useRuntimePendingStore } from '../../browser/stores/runtime-pending-store';
import { useSandboxConnectionStore } from '../../browser/stores/sandbox-connection-store';
import { useServerStore } from '../../browser/stores/server-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import { onHostSignal } from '../../core/session/host-signals';
import type { StreamRevival } from './stream-revival';
import { useKortixRouteWorkspaceId } from '../route-project';
import { useCurrentRuntime } from '../use-current-runtime';
import {
  connectRuntimeStream,
  type RuntimeEventStreamOptions,
  type RuntimeStreamWiring,
} from './connect-stream';
import { shouldReconnectOnHostSignal } from './runtime-stream-signals';
import { createStreamRevival } from './stream-revival';
import { useEventStreamRefs } from './use-event-stream-refs';

export { subscribeRuntimeStream, type RuntimeStreamSignal } from './runtime-stream-signals';

/**
 * The store subscriptions and mount refs the connection effect reads: the
 * selectors re-render the hook when a store value changes, so the effect's
 * deps see the change and the connection policy is re-run with fresh inputs.
 */
function useRuntimeStreamWiring(): RuntimeStreamWiring {
  const queryClient = useQueryClient();
  // The project this SSE connection's events are about — threaded into
  // `refetchKortixSessionMirrors` so a title/tree mirror refetch stays scoped
  // to the project actually being viewed instead of guessing at "every
  // project" (see that function's doc comment in `helpers.ts`).
  const projectId = useKortixRouteWorkspaceId();
  const addPermission = useRuntimePendingStore((s) => s.addPermission);
  const removePermission = useRuntimePendingStore((s) => s.removePermission);
  const addQuestion = useRuntimePendingStore((s) => s.addQuestion);
  const removeQuestion = useRuntimePendingStore((s) => s.removeQuestion);
  const clearPending = useRuntimePendingStore((s) => s.clear);
  const stopCompaction = useRuntimeCompactionStore((s) => s.stopCompaction);
  const startCompaction = useRuntimeCompactionStore((s) => s.startCompaction);
  const applySyncEvent = useSyncStore((s) => s.applyEvent);
  // Re-render (and re-read getActiveServerUrl, which resolves current-runtime) when
  // the session's runtime changes — so the SSE re-subscribes to the new daemon.
  const runtimeVersion = useCurrentRuntime((s) => s.version);
  const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
  const sandboxStatus = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const isMountRef = useRef(true);
  const prevRuntimeVersionRef = useRef(runtimeVersion);
  const prevServerUrlRef = useRef(activeServerUrl);
  return {
    queryClient,
    projectId,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    clearPending,
    stopCompaction,
    startCompaction,
    applySyncEvent,
    runtimeVersion,
    activeServerUrl,
    sandboxStatus,
    runtimeHealthy,
    isMountRef,
    prevRuntimeVersionRef,
    prevServerUrlRef,
  };
}

/** One revival instance and the generation bump that re-opens the stream with it. */
function useStreamRevival(): { revival: StreamRevival; streamGeneration: number } {
  // Bumped when a parked stream earns another attempt. It is an effect DEP, so
  // the bump tears the dead handle down and opens a fresh one — the same path
  // a runtime switch takes, rather than a second reconnect mechanism.
  const [streamGeneration, setStreamGeneration] = useState(0);
  const revival = useMemo(
    () => createStreamRevival(() => setStreamGeneration((generation) => generation + 1)),
    [],
  );
  useEffect(() => revival.stop, [revival]);
  // A host without DOM events (React Native) reports foreground, online and a
  // manual retry. A fresh generation reconnects and re-reads the transcripts.
  useEffect(
    () =>
      onHostSignal((signal) => {
        const lastEvidenceAt = useSandboxConnectionStore.getState().lastRuntimeEvidenceAt;
        if (!shouldReconnectOnHostSignal(signal, lastEvidenceAt, Date.now())) return;
        setStreamGeneration((generation) => generation + 1);
      }),
    [],
  );
  return { revival, streamGeneration };
}

/**
 * Connects to the session runtime's SSE event stream via the SDK and
 * performs INCREMENTAL cache updates on React Query data.
 *
 * Instead of invalidating queries (which triggers full refetches),
 * we use setQueryData to surgically update messages, parts, sessions, etc.
 * This matches the SolidJS reference implementation's approach.
 *
 * This hook is a THIN React wrapper: the actual connect/reconnect/backoff,
 * heartbeat watchdog, and event-coalescing machinery is framework-free and
 * lives in `core/stream/event-stream.ts`'s `openEventStream()`. Everything here is
 * either genuinely React-only (effect lifecycle, store subscriptions) or
 * needs the React Query `QueryClient` (cache reads/writes, which
 * `createEventHandler` and `hydrateFromPending` — via `connectRuntimeStream` — perform).
 */
export function useRuntimeEventStream(options: RuntimeEventStreamOptions = {}) {
  const wiring = useRuntimeStreamWiring();
  const { revival, streamGeneration } = useStreamRevival();
  const streamRefs = useEventStreamRefs({
    queryClient: wiring.queryClient,
    stopCompaction: wiring.stopCompaction,
    applySyncEvent: wiring.applySyncEvent,
  });

  useEffect(
    () =>
      connectRuntimeStream({
        options: {
          enabled: options.enabled,
          projectId: options.projectId,
          sessionId: options.sessionId,
        },
        wiring,
        revival,
        streamRefs,
      }),
    // NOTE: urlVersion is intentionally excluded from deps. We only reconnect
    // when the resolved activeServerUrl actually changes, which avoids
    // reconnecting on metadata-only updates while still recovering from
    // stale SSE connections after sandbox/proxy URL changes.
    [
      wiring.queryClient,
      wiring.addPermission,
      wiring.removePermission,
      wiring.addQuestion,
      wiring.removeQuestion,
      wiring.clearPending,
      wiring.runtimeVersion,
      wiring.activeServerUrl,
      wiring.sandboxStatus,
      wiring.runtimeHealthy,
      options.enabled,
      options.projectId,
      options.sessionId,
      wiring.applySyncEvent,
      wiring.stopCompaction,
      wiring.projectId,
      revival,
      // A revived park re-opens the stream through this effect. Without it the
      // park stayed terminal for the page.
      streamGeneration,
    ],
  );
}

/**
 * Headless provider component that connects the SSE event stream.
 * Renders nothing — just call useRuntimeEventStream().
 *
 * Mount this once on any page that needs live session updates
 * (dashboard layout, onboarding page, etc.).
 */
export function RuntimeEventStreamProvider() {
  useRuntimeEventStream();
  return null;
}
