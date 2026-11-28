import type { SessionControlStreamOptions } from '../session/control-stream';
import type { SavedCopyStore } from '../session-sync/saved-copy-store';
import { readSessionLog, SESSION_LOG_FIRST_PAGE_LIMIT, type LoadSessionLogPage, type SessionLogRead, type SessionLogPage } from './source';
import { isStaleSessionLogPage, type SessionLogState, type SessionLogEventInput } from './store';

interface LogSyncStore {
  sessionLogs: Record<string, SessionLogState>;
  applySessionLogPage(sessionId: string, page: SessionLogPage, beforeSeq?: number, options?: { box?: boolean }): void;
  applySessionLogEvent(sessionId: string, event: SessionLogEventInput): void;
  dropSessionLog(sessionId: string): void;
}

/** Owns one session log's reads and stream until its host disposes it. */
export function startSessionLogSync({ projectId, sessionId, loader, store, copies, joinStream, schedule, onTabVisible, boxReady, onRead, setMissing, reloadRef }: {
  projectId: string; sessionId: string; loader: LoadSessionLogPage;
  store: () => LogSyncStore; copies: SavedCopyStore | null;
  joinStream: (options: SessionControlStreamOptions) => { close: () => void };
  schedule: (run: () => void, ms: number) => () => void;
  onTabVisible: (run: () => void) => () => void;
  boxReady: () => boolean;
  onRead: (outcome: 'page' | 'missing' | 'failed') => void;
  setMissing: (missing: boolean) => void;
  reloadRef?: { current: (() => void) | null };
}) {
    const controller = new AbortController();
    let stream: { close: () => void } | null = null;
    let stopped = false;
    let busy = false;
    // The last turn end the session stream reported, kept across re-joins: a different one is a turn end.
    let lastEnded: string | null | undefined;
    // The running turns a mid-turn read was scheduled for, kept across re-joins: one read per turn.
    const midTurn = new Set<string>();
    // The page answered: the stream is on `schema=v2`.
    let onV2 = false;
    // Failed reads since the last answer, and the pending timed retry.
    let failures = 0;
    // Reads that answered "no log yet", for the backoff of the next one.
    let missingReads = 0;
    let cancelRetry: (() => void) | null = null;
    const join = (options: Omit<SessionControlStreamOptions, 'projectId' | 'sessionId'>) => {
      stream?.close();
      stream = joinStream({ projectId, sessionId, ...options });
    };
    let pageRevision = 0;
    let appliedPageRevision = 0;
    // Order successful pages by request start, stored and live alike. A newer failed request
    // cannot invalidate a useful answer. Stream record revisions and tombstones are reconciled
    // by the reducer, not this ordering.
    const load = async (live: boolean): Promise<SessionLogRead> => {
      if (stopped) return { answer: null, retryAfterMs: null };
      const revision = ++pageRevision;
      const query = live ? { limit: SESSION_LOG_FIRST_PAGE_LIMIT, live: true } : { limit: SESSION_LOG_FIRST_PAGE_LIMIT };
      const read = await readSessionLog(loader, projectId, sessionId, query, controller.signal);
      if (stopped) return { answer: null, retryAfterMs: null };
      const { answer } = read;
      const held = store().sessionLogs[sessionId];
      // A page of an older generation than the log's holds nothing newer: not applied, not saved.
      if (answer && answer !== 'missing' && revision > appliedPageRevision && !(held && isStaleSessionLogPage(held, answer))) {
        appliedPageRevision = revision;
        // Only the box's page answers for the tail. A page with no `source` (an API from before
        // `live`) is the stored log.
        const box = answer.source === 'box';
        store().applySessionLogPage(sessionId, answer, undefined, box ? { box } : undefined);
        if (!box) void copies?.write(projectId, sessionId, answer);
      }
      return read;
    };
    // The live read. One on the wire at a time: a reconnect, a resync, a tab-visible signal and
    // a turn end can fire together, and they would all read the same page.
    let liveRead: Promise<SessionLogRead> | null = null;
    const reload = (): Promise<SessionLogRead> => {
      if (!liveRead) {
        liveRead = (async () => {
          const read = await load(true);
          // No page this client can read (a record it does not know, the network, a 5xx): the
          // stored log, as a failed box read always fell back to it.
          return read.answer === null && !stopped ? load(false) : read;
        })().finally(() => {
          liveRead = null;
        });
      }
      return liveRead;
    };
    // The re-read a turn end asks for. A live read already on the wire started before the turn
    // ended and answers a snapshot without the finished reply: read again once it settles.
    let cancelSettlement: (() => void) | null = null;
    let settlement = 0;
    // Turn-end can precede the durable journal commit. Bound follow-ups even when
    // a valid page is incomplete: the page has no turn-token commit watermark.
    const followSettlement = () => {
      cancelSettlement?.();
      const token = ++settlement;
      let retry = 0;
      const next = () => {
        if (stopped || token !== settlement || retry === SESSION_LOG_RETRY_DELAYS_MS.length) return;
        cancelSettlement = schedule(() => {
          cancelSettlement = null;
          if (stopped || token !== settlement) return;
          void (onV2 ? reload() : attempt()).finally(next);
        }, SESSION_LOG_RETRY_DELAYS_MS[retry++] ?? SESSION_LOG_RETRY_MAX_MS);
      };
      next();
    };
    const reloadAfterTurnEnd = () => {
      followSettlement();
      const stale = liveRead;
      void (stale ? stale.then(() => reload()) : reload());
    };
    // A `kortix.control.turn` frame that reports a turn end this effect has not seen. The first
    // frame of a connection names the last end at join, which is not news.
    const endedTurn = (frame: { type: string; payload?: unknown }): boolean => {
      if (frame.type !== 'kortix.control.turn') return false;
      const payload = frame.payload as { last_ended?: { turn_token?: string } | null } | null;
      const ended = payload?.last_ended?.turn_token ?? null;
      const seen = lastEnded;
      lastEnded = ended;
      if (seen === undefined && ended) followSettlement();
      return seen !== undefined && ended !== seen;
    };
    // Re-read after a reconnect (`up` after a drop); the first report is the connection already up.
    const onReconnect = (run: () => void) => {
      let connected = true;
      return (up: boolean) => {
        if (up && !connected) run();
        connected = up;
      };
    };
    const goV2 = () => {
      failures = 0;
      missingReads = 0;
      cancelRetry?.();
      cancelRetry = null;
      setMissing(false);
      // A v2 connection resumes at the v1 cursor; a server on another epoch answers
      // `kortix.resync` and replays nothing, so the page is read again then, as after a reconnect.
      // `runtime: true`: the `log.*` frames ride the runtime channel. A full session already has a
      // runtime subscriber; a view (`useSessionView`) has none, and its thread froze at the first page.
      join({
        schema: 'v2',
        runtime: true,
        // The join snapshot can precede the full runtime consumer after reload.
        // The log owns these frames from its first subscription. Store puts and
        // wire deltas are idempotent when another runtime consumer also sees them.
        onRuntimeEvent: (event) => {
          if (event.type.startsWith('log.')) store().applySessionLogEvent(sessionId, event);
        },
        // A missed final record converges through the page at turn end (F-012).
        onControl: (frame) => {
          if (endedTurn(frame)) reloadAfterTurnEnd();
        },
        onConnectionChange: onReconnect(() => void reload()),
        onRuntimeResync: () => void reload(),
      });
    };
    // The box got ready after the first read: read the page live now. A live read already on the
    // wire may have asked while the box was not ready: read again once it settles.
    const readLive = () => {
      if (stopped) return;
      if (!onV2) return void attempt();
      const pending = liveRead;
      void (pending ? pending.then(() => reload()) : reload());
    };
    const attempt = async (): Promise<void> => {
      if (busy || stopped) return;
      cancelRetry?.();
      cancelRetry = null;
      busy = true;
      const { answer, retryAfterMs } = await load(false);
      const page = answer === 'missing' ? null : answer;
      if (stopped) return;
      if (page) {
        // The stored page already establishes v2. Start receiving the join snapshot
        // now; the live read must not delay a streaming answer.
        onV2 = true;
        onRead?.('page');
        goV2();
        if (boxReady()) await reload();
        busy = false;
        return;
      }
      // No stored page: a ready box holds the log of a new session before its journal posts.
      const live = boxReady() ? (await reload()).answer : null;
      busy = false;
      if (stopped) return;
      onV2 = !!live && live !== 'missing';
      onRead?.(onV2 ? 'page' : answer === 'missing' ? 'missing' : 'failed');
      if (onV2) {
        goV2();
        return;
      }
      setMissing(true);
      if (answer === 'missing') {
        // The API holds no log for this session: a copy kept on the device is not its history.
        failures = 0;
        store().dropSessionLog(sessionId);
        // A new session's journal posts within seconds of its first turn. A view
        // (`useSessionView`) joins without the full control state and never sees that turn
        // end, so the page is also read again on a backoff until the log exists.
        const ms = SESSION_LOG_MISSING_DELAYS_MS[Math.min(missingReads, SESSION_LOG_MISSING_DELAYS_MS.length - 1)]!;
        missingReads += 1;
        cancelRetry = schedule(() => void attempt(), ms);
      } else if (failures < SESSION_LOG_RETRY_DELAYS_MS.length) {
        // A failed read is not "no log": the copy on screen stays, and the page is read again.
        const ms = Math.min(retryAfterMs ?? SESSION_LOG_RETRY_DELAYS_MS[failures]!, SESSION_LOG_RETRY_MAX_MS);
        failures += 1;
        cancelRetry = schedule(() => void attempt(), ms);
      }
      // No page is also read again at the next turn end and after a stream reconnect, on the
      // session stream without `schema=v2`.
      join({
        onControl: (frame) => {
          if (frame.type !== 'kortix.control.turn') return;
          if (endedTurn(frame)) return void attempt();
          const payload = frame.payload as { turns?: { turn_token?: string }[] } | null;
          // A running turn (also one the state at join holds): its user message frame may have
          // passed before this tab's runtime connection, which is live-only. pi journals while a
          // turn runs, so the page holds that message after the next mid-turn post.
          for (const turn of payload?.turns ?? []) {
            const token = turn?.turn_token;
            if (!token || midTurn.has(token)) continue;
            midTurn.add(token);
            if (!cancelRetry) cancelRetry = schedule(() => void attempt(), SESSION_LOG_MID_TURN_READ_MS);
          }
        },
        onConnectionChange: onReconnect(() => void attempt()),
      });
    };
    void (async () => {
      const saved = await Promise.resolve(copies?.read(projectId, sessionId) ?? null).catch(() => null);
      if (stopped) return;
      if (saved && !store().sessionLogs[sessionId]) store().applySessionLogPage(sessionId, saved);
      await attempt();
    })();
    // A tab that comes back is the least sure it has every frame (a background tab can lose
    // its stream silently): read the newest page again, as the v1 transcript reads its tail.
    // A refused session waits for its next turn end or reconnect instead.
    const stopVisible = onTabVisible(() => {
      if (onV2) void reload();
    });
    if (reloadRef) reloadRef.current = () => void (onV2 ? reload() : attempt());
    const dispose = () => {
      if (reloadRef) reloadRef.current = null;
      stopVisible();
      stopped = true;
      cancelRetry?.();
      cancelSettlement?.();
      controller.abort();
      stream?.close();
      store().dropSessionLog(sessionId);
    };
    return { readLive, dispose };
}

/** The waits before the timed re-reads of a page that failed: three tries in about 42 s. */
const SESSION_LOG_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
/** The waits before reading a session with no log yet again: then every 30 s until it has one. */
const SESSION_LOG_MISSING_DELAYS_MS = [3_000, 5_000, 10_000, 15_000, 30_000];
/** A running turn's read on a session with no log yet: after pi's mid-turn journal post (5 s). */
const SESSION_LOG_MID_TURN_READ_MS = 6_000;
/** The longest wait a `Retry-After` can set. */
const SESSION_LOG_RETRY_MAX_MS = 60_000;
