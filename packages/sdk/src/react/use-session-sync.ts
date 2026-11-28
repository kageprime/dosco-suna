'use client';

import type { SessionStatus, Todo } from '../core/runtime/runtime-types';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  claimSessionCacheOwnership,
  getSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  sessionCacheOwnerScopesConflict,
} from '../browser/session-sync/session-cache-ownership';
import {
  getSessionSyncController,
  loadSessionExportMessages,
  loadSessionRuntimeStatus,
  resetSessionSyncControllersForSession,
  retainSessionSyncController,
} from '../browser/session-sync/session-sync-registry';
import { parseKortixSessionScope } from '../browser/session-sync/session-scope';
import { type SessionLogPage, loadSessionLogPage, readFirstSessionLogAnswer } from '../core/session-log/source';
import { transcriptIsFragment } from '../core/session-sync/fragment';
import { onTabVisible } from '../browser/session-sync/visibility';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { useCurrentRuntime } from './use-current-runtime';
import { selectSessionRows } from './session-transcript-subscription';
import { canQueryRuntimeSession } from './use-runtime-sessions';

export { loadSessionExportMessages, loadSessionRuntimeStatus };

/** The two store slices the fragment check reads. Local so this file does not
 *  depend on the store's full published shape. */
interface SyncStoreShape {
  messages: Record<string, unknown[] | undefined>;
  wasTranscriptEvicted: (sessionID: string) => boolean;
}

type FileDiff = Omit<import('../core/runtime/runtime-types').SnapshotFileDiff, 'patch'> & {
  patch?: string;
  before?: string;
  after?: string;
};

const EMPTY_DIFFS: FileDiff[] = [];
const EMPTY_TODOS: Todo[] = [];
const IDLE_STATUS = { type: 'idle' } as SessionStatus;

/**
 * Returns the current session tail and explicit history-loading state.
 * Network synchronization lives in the framework-free SessionSyncController.
 */
interface UseSessionSyncOptions {
  /**
   * The session stream is connected (R5.3): no liveness or verify reads.
   * Omit it when this hook does not watch the stream; another hook on the same
   * session then decides.
   */
  streamConnected?: boolean;
  /**
   * `null`: the host reads the session's saved history itself (`readSavedSessionCopy`,
   * `useSession`), so this hook reads nothing saved. Omit it and the hook reads the session log
   * (`GET …/log`): a page goes in the session store, and the session reads its log from then on.
   * Any other answer reads nothing more.
   */
  mirror?: null;
  /**
   * Stable Kortix `(projectId, sessionId)` scope for disk transcript ownership.
   * This prevents equal runtime session ids in different sandboxes from sharing data.
   */
  kortixSessionScope?: string;
  /**
   * Allow live REST reconciliation against the current runtime.
   * Set false while `/start` has not switched this Kortix session's sandbox.
   */
  networkEnabled?: boolean;
  /**
   * The caller's working projection (`useSessionWorking`), when it has one.
   *
   * It is the transcript liveness poll's switch. Reading the raw `session.status`
   * slot instead means a dropped busy frame — a backgrounded tab, a proxy
   * reconnect across the start of a turn — leaves the poll off for a turn the
   * server's own authority says is running, and the transcript then never
   * refreshes behind the missing stream. Omit it (apps/mobile) and the stream
   * slot decides, as before.
   */
  working?: boolean;
  /**
   * The control plane is holding a turn open for this session
   * (`useSessionWorking().serverOpenTurnToken !== null`), even when the
   * projection's ANSWER is idle.
   *
   * This is the poll's escape from a chicken-and-egg the projection alone
   * cannot break: a stale wire idle frame (a dead SSE stream's last word)
   * vetoes the server's open turn row, the projection answers idle, and
   * `working: false` switches off the very tail read whose evidence — the
   * runtime still producing output — would prove the veto wrong. Keeping the
   * poll on while the server holds a turn open lets that evidence arrive
   * (`hydrate` stamps `sessionActivityAt` when a runtime read shows the
   * transcript moved mid-turn), and the projection's content-first rule does
   * the rest. Costs one bounded tail read per interval, only while the
   * disagreement lasts; never touches the public `isBusy`.
   */
  serverHoldsTurn?: boolean;
  /**
   * Re-render the caller whenever the transcript changes. Default `true`.
   *
   * `false` keeps every network effect running but stops subscribing to the
   * message rows, so a streamed delta does not re-render the caller. `messages`
   * is then the transcript as of the caller's render, not a live value. Read
   * the live transcript where it is drawn, with `useSessionMessages`.
   */
  subscribeMessages?: boolean;
  /**
   * `sessionId` is a sub-agent's runtime session inside `kortixSessionScope`'s
   * session (the session a sub-agent row opens). Nothing is kept on the device
   * for it: the device slot of a scope holds the conversation's copy.
   */
  savedChild?: boolean;
  /**
   * The session log (v2) owns this session's history: this hook reads no saved copy (`mirror` is
   * ignored). The runtime tail and the live rows still fill the store; older history is the
   * session log's. It is also on, whatever this says, while the session store holds the log of
   * `kortixSessionScope`'s session (`useSession` read it).
   */
  sessionLog?: boolean;
}

/**
 * Is this session working, as far as THIS hook can answer?
 *
 * One rule with two readers: the poll's switch below, and the hook's public
 * `isBusy`. They disagreed — `isBusy` derived from the raw stream slot while
 * `livenessBusy` already preferred the caller's projection — so the hook handed
 * out the weaker of two answers it computed side by side.
 */
export function sessionSyncBusy(input: {
  working: boolean | undefined;
  streamBusy: boolean;
}): boolean {
  return input.working ?? input.streamBusy;
}

/**
 * Whether the transcript liveness poll should be running. Pure, so "the
 * projection outranks the stream slot" is a test rather than a convention.
 */
export function livenessBusy(input: {
  networkEnabled: boolean;
  /**
   * Read, and deliberately IGNORED. Retained because this object is a
   * published parameter shape.
   *
   * It used to gate the poll, which inverted the whole point of having one:
   * the repair for a broken stream was switched off by the health probe, and
   * the health probe is the signal that flaps. A loaded box that misses its
   * probe deadline mid-turn lost its transcript repair at the exact moment it
   * needed it, for as long as the probe kept missing. If the box truly is
   * unreachable the tail read fails on its own — bounded by the controller's
   * deadline — at a cost of one request per interval.
   */
  runtimeHealthy?: boolean;
  working: boolean | undefined;
  streamBusy: boolean;
  /** See {@link UseSessionSyncOptions.serverHoldsTurn}: the control plane still
   *  holds a turn open, which keeps the verification poll on even when the
   *  projection answers idle (a stale wire idle frame can veto the row). */
  serverHoldsTurn?: boolean;
}): boolean {
  if (!input.networkEnabled) return false;
  return sessionSyncBusy(input) || input.serverHoldsTurn === true;
}

export function useSessionSync(sessionId: string, options: UseSessionSyncOptions = {}) {
  const {
    kortixSessionScope,
    working,
    serverHoldsTurn,
    mirror,
    subscribeMessages = true,
    savedChild = false,
  } = options;
  // The session log holds the transcript (`runtime.log.v1`, every box past the runtime floor), so
  // no mount of this hook (an export dialog, a sub-agent view) reads the box's transcript routes
  // or polls them, whatever `networkEnabled` asks.
  const networkEnabled = false;
  const scopeSessionId = parseKortixSessionScope(kortixSessionScope)?.sessionId;
  const logHeld = useSyncStore((state) => !!scopeSessionId && state.sessionLogs[scopeSessionId] !== undefined);
  const sessionLog = options.sessionLog === true || logHeld;
  const runtimeHealthy = useSandboxConnectionStore((state) => state.healthy === true);
  const runtimeScope = useCurrentRuntime((state) => state.sandboxId) ?? 'none';
  const cacheOwnerScope = resolveSessionCacheOwnerScope(runtimeScope, kortixSessionScope);
  const currentOwner = getSessionCacheOwnership(sessionId);
  const cacheBelongsToAnotherRuntime =
    !!sessionId && sessionCacheOwnerScopesConflict(currentOwner, cacheOwnerScope);
  const readableSessionId = cacheBelongsToAnotherRuntime ? '' : sessionId;
  const controller = getSessionSyncController(sessionId, undefined, runtimeScope);
  const sync = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // Reference-count the mounted consumers of this session's transcript so the
  // store can free it once the last one is gone — without this, every session
  // opened in the tab stays resident for the tab's lifetime.
  //
  // Deliberately NOT folded into the `retainSessionSyncController` call below.
  // That hold is also gated on `networkEnabled` + `runtimeHealthy`, and a
  // session read while its sandbox is still booting is precisely the case the
  // disk paint exists for: eviction there would blank the transcript the user
  // is looking at. Consumers are consumers whether or not the runtime is up.
  useEffect(() => {
    if (!canQueryRuntimeSession(sessionId)) return;
    return useSyncStore.getState().retainSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!canQueryRuntimeSession(sessionId) || !cacheOwnerScope) return;
    const claim = claimSessionCacheOwnership(sessionId, cacheOwnerScope);
    if (!sessionCacheOwnerScopesConflict(claim.previousOwnerScope, cacheOwnerScope)) {
      return;
    }
    resetSessionSyncControllersForSession(
      sessionId,
      runtimeScope === 'none' ? undefined : runtimeScope,
    );
    useSyncStore.getState().clearSession(sessionId);
  }, [cacheOwnerScope, runtimeScope, sessionId]);

  // FIRST PAINT FROM THE SESSION LOG — deliberately NOT gated on
  // `networkEnabled`, `runtimeHealthy`, or `runtimeScope`.
  //
  // That is the whole point. Every other read in this hook waits for the box;
  // opening a hibernated session therefore showed a full-screen loader with no
  // transcript for the length of the wake (measured 5-240 s) although every
  // message existed. This read asks the CONTROL PLANE, which is up, for the
  // session log the daemon journals at each turn end (`GET …/log`). A page goes
  // in the session store, and `logHeld` then turns this effect off.
  //
  // The read's answer is also REPORTED (`mirrorState` below), because a host
  // decides from it what to show while the box wakes: placeholder rows while a
  // saved copy is on its way, its boot screen when there is none. Only the
  // negative answer is stored here; `painted` is read off the store itself.
  const mirrorKey = `${kortixSessionScope ?? ''}|${sessionId}|${mirror === null ? 'null' : 'read'}${
    savedChild ? '|child' : ''
  }`;
  const [mirrorAbsentFor, setMirrorAbsentFor] = useState<string | null>(null);
  useEffect(() => {
    if (sessionLog || !canQueryRuntimeSession(sessionId) || !kortixSessionScope) return;
    // Already have the thread (a warm remount, or the runtime beat us): nothing to paint.
    if ((useSyncStore.getState().messages[sessionId]?.length ?? 0) > 0) return;
    const abort = new AbortController();
    const scope = parseKortixSessionScope(kortixSessionScope);
    // `mirror: null`: the host reads the saved history itself. No page reads nothing more.
    const read: Promise<SessionLogPage | 'missing' | null> =
      mirror === null || !scope || !loadSessionLogPage
        ? Promise.resolve(null)
        : readFirstSessionLogAnswer(loadSessionLogPage, scope.projectId, scope.sessionId, abort.signal);
    void read.then((page) => {
      if (abort.signal.aborted) return;
      if (!page || page === 'missing') {
        setMirrorAbsentFor(mirrorKey);
        return;
      }
      useSyncStore.getState().applySessionLogPage(scope!.sessionId, page);
    });
    return () => abort.abort();
  }, [kortixSessionScope, sessionId, mirror, mirrorKey, savedChild, sessionLog]);

  // NO DISK PAINT. The transcript renders from the runtime and from this tab's
  // own optimistic writes — nothing else.
  //
  // There used to be an IndexedDB mirror here, hydrated before `runtimeHealthy`
  // so a hibernated session showed its history instead of a blank screen for
  // the length of a VM boot. It was removed because it could not tell a
  // FINISHED turn from a running one. Its write gate was structural (message
  // count, total part count, tail id), and the two changes that end a turn move
  // none of those: `time.completed` stamped on the tail message, and the `error`
  // an abort stamps. A normal turn escaped by accident, because the runtime
  // appends a `step-finish` part and that moves the part count — but a STOP
  // appends no part at all. So the disk copy of a stopped thread held an
  // assistant message with neither `time.completed` nor `error`, which
  // `open-turn.ts` reads as STILL RUNNING: on the next cold paint the stopped
  // turn shimmered and every message the user sent after it dimmed to "Queued".
  //
  // The cold-open cost is real and known — see `session-sync-registry`'s
  // `reconcile('initial')` below, which is now the only thing that fills the
  // transcript. If the blank wake is worth solving again, it needs a mirror
  // whose freshness test reads the MESSAGE, not its shape.
  // ASK AS SOON AS WE KNOW WHICH SANDBOX — not when a probe agrees.
  //
  // This read used to wait for `runtimeHealthy === true`, and that one
  // condition is what hung the session page. `resolveSessionContentState` keeps
  // the web app on its "Waking the agent" loader while there are no messages,
  // and this read is the only thing that produces messages. So the page's ONLY
  // exit was a health probe — the least reliable signal in the system — and a
  // box that was up while failing its probe showed a spinner over a session
  // that could have been read the whole time. The sidebar, reading the session
  // list instead, showed the same session as live: one page, two answers.
  //
  // The read IS the liveness check. If the runtime is not up the request fails
  // and the controller retries with backoff until it lands, so readiness
  // becomes a byproduct of asking for what we wanted anyway.
  useEffect(() => {
    if (!networkEnabled || !canQueryRuntimeSession(sessionId) || runtimeScope === 'none') return;
    resetSessionSyncControllersForSession(sessionId, runtimeScope);
    const release = retainSessionSyncController(sessionId, runtimeScope);
    // The ONLY thing that fills the transcript. One bounded tail, so events
    // produced while this route was inactive are not skipped.
    void controller.reconcile('initial');
    return release;
  }, [controller, networkEnabled, runtimeScope, sessionId]);

  // A transcript the live stream rebuilt after an eviction starts
  // mid-conversation, and nothing else will correct it: the mount already ran,
  // so no `initial` read is coming, and the liveness poll only turns on while
  // the session is working. Removing the IndexedDB mirror (5a7a43517f) named
  // this exact hole and left it open — "no reconcile is keyed on eviction …
  // can sit on a partial transcript until a reload".
  //
  // Subscribed rather than checked once, because the refill happens while this
  // component is already mounted. `hydrate` clears the mark, so the successful
  // read is what disarms this.
  useEffect(() => {
    if (!networkEnabled || !canQueryRuntimeSession(sessionId)) return;
    let repairing = false;
    const check = (state: SyncStoreShape) => {
      if (repairing) return;
      if (
        !transcriptIsFragment({
          hasMessages: (state.messages[sessionId]?.length ?? 0) > 0,
          wasEvicted: state.wasTranscriptEvicted(sessionId),
        })
      ) {
        return;
      }
      repairing = true;
      void controller.reconcile('eviction').finally(() => {
        repairing = false;
      });
    };
    check(useSyncStore.getState() as unknown as SyncStoreShape);
    return useSyncStore.subscribe((state) => check(state as unknown as SyncStoreShape));
  }, [controller, networkEnabled, sessionId]);

  // Coming back to the tab is a moment of MAXIMUM uncertainty, so it is a
  // moment to re-read. A backgrounded tab has its timers clamped (Chrome: about
  // one tick a minute), so the 10s liveness poll effectively stops, and the SSE
  // connection can be dropped with no visible error. Whatever the transcript
  // shows on return was assembled from a stream nobody was watching. One
  // bounded tail read settles it.
  useEffect(() => {
    if (!networkEnabled || !canQueryRuntimeSession(sessionId)) return;
    return onTabVisible(() => {
      void controller.reconcile('visible');
    });
  }, [controller, networkEnabled, sessionId]);

  // `subscribeMessages: false` selects a constant, so the store never
  // re-renders the caller for a row change; the rows are read once per render.
  const liveMessages = useSyncStore((state) =>
    subscribeMessages ? selectSessionRows(state, readableSessionId) : null,
  );
  const messages = liveMessages ?? selectSessionRows(useSyncStore.getState(), readableSessionId);

  // The runtime's own status, unmodified.
  //
  // A busy OVERRIDE used to sit here: while a prompt was "observed", an idle
  // runtime status was rewritten to busy. It was a guess with a latch — every
  // signal that could release it can be lost — and it is what left sessions
  // rendering as working until the user reloaded. "Is this session working?"
  // is now answered once, by `useSessionWorking` over the server's turn
  // authority; this hook reports what the stream said and nothing more.
  //
  // The `?? IDLE_STATUS` default is a DISPLAY convenience and deliberately not
  // what the projection reads: `useSessionWorking` reads the raw slot, where
  // absence means "no frame has ever been observed" — silence, not idle —
  // because reading silence as idle is what unmasked live turns. Widening this
  // to `SessionStatus | undefined` would be a breaking change to a published
  // return type and buys nothing now that `isBusy` no longer derives from it.
  const status = useSyncStore(
    (state) => state.sessionStatus[readableSessionId] ?? IDLE_STATUS,
  ) as SessionStatus;
  const diffs = useSyncStore((state) => state.diffs[readableSessionId]) as FileDiff[] | undefined;
  const todos = useSyncStore((state) => state.todos[readableSessionId]) as Todo[] | undefined;

  const streamBusy = status.type === 'busy' || status.type === 'retry';
  // Published, so it cannot be removed — but it is now an ALIAS of the
  // projection when the caller passed one, so the hook's public answer and the
  // poll's switch are the same rule instead of two.
  const isBusy = sessionSyncBusy({ working, streamBusy });
  const isLoading = !useSyncStore((state) => readableSessionId in state.messages);
  // What the saved-copy paint came to. `painted` is read off the store; only
  // a refused or empty answer needs its own slot. A landed runtime read with
  // no messages is NOT an answer: it is lost box state, and the saved copy may
  // still paint over it (the paint effect's gate), so it stays `loading`.
  const mirrorState: 'idle' | 'loading' | 'painted' | 'absent' =
    !canQueryRuntimeSession(sessionId) || !kortixSessionScope
      ? 'idle'
      : messages.length > 0
        ? 'painted'
        : mirrorAbsentFor === mirrorKey
          ? 'absent'
          : 'loading';

  // The controller is shared by every hook on this session. Only a hook that
  // passes `streamConnected` speaks for the stream; one that omits it (an
  // export dialog) must not switch the verification poll back on.
  useEffect(() => {
    if (options.streamConnected === undefined) return;
    controller.setStreamReliable(options.streamConnected);
    return () => controller.setStreamReliable(false);
  }, [controller, options.streamConnected]);

  useEffect(() => {
    // No runtime session to read (`''` under `useSession({ chatEngine: false })`):
    // the controller never goes busy, so no poll and no turn-end read start.
    const readable = canQueryRuntimeSession(sessionId);
    controller.setBusy(
      readable && livenessBusy({ networkEnabled, runtimeHealthy, working, streamBusy, serverHoldsTurn }),
      networkEnabled && readable && runtimeScope !== 'none',
    );
  }, [controller, streamBusy, networkEnabled, runtimeHealthy, working, serverHoldsTurn, sessionId, runtimeScope]);

  // Older history is the runtime's here; a session's saved history pages through
  // its log (`useSessionLogOlder`). No v1 window is paged (P8.3).
  const hasOlder = sync.hasOlder;
  const loadOlder = useCallback((): Promise<void> => (hasOlder ? controller.loadOlder() : Promise.resolve()), [controller, hasOlder]);

  // Re-read the tail on demand. The transcript body renders this behind its
  // "couldn't load" state so `freshness === 'error'` is recoverable without a
  // page reload or a full sandbox restart — it just asks the controller to
  // reconcile again, which is the same read the mount and the poll do.
  const retryTranscript = useCallback(() => {
    void controller.reconcile('manual');
  }, [controller]);

  return {
    messages,
    status,
    freshness: sync.freshness,
    retryTranscript,
    isBusy,
    isLoading,
    /**
     * The server's saved copy of this transcript (the mirror): `idle` until a
     * root and a Kortix scope are known, `loading` while its read is in
     * flight, `painted` once the store holds messages, `absent` when the read
     * answered with nothing it may paint. `useSession` folds it into
     * `savedTranscript`.
     */
    mirrorState,
    hasOlder,
    isLoadingOlder: sync.isLoadingOlder,
    loadOlder,
    diffs: diffs ?? EMPTY_DIFFS,
    todos: todos ?? EMPTY_TODOS,
  };
}
