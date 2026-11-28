/**
 * The last saved copies of a user's sessions, kept on the device.
 *
 * Opening a session painted nothing until the control plane answered with the
 * session's saved history: skeleton rows for 0.3-2.3 s on every cold open, and
 * for as long as the backend took when it was slow. With this store the next
 * open paints the last copy as soon as the device reads it (one task after the
 * first frame), and the fresh page reconciles into it by message id.
 *
 * WHAT IT STORES, AND WHY THAT IS SAFE. Only pages the SERVER sent: the newest
 * page of the session log's root thread (`GET …/log`, `SessionLogPage`), which
 * the daemon journals at each turn end. Every read validates the page
 * (`isSessionLogPage`). It never stores the live transcript. An IndexedDB mirror
 * of the live store was deleted (`5a7a43517f`) because its write test read the
 * transcript's shape, missed a Stop, and painted a stopped turn as running. A
 * server page has no client-side freshness test to get wrong.
 *
 * Framework-free: the host passes the storage (IndexedDB on web, through
 * `indexedDBKeyValueStorage`; AsyncStorage on mobile) and the signed-in user.
 * Both are asynchronous, so no read blocks a frame. Every failure — a full,
 * corrupt or missing store — costs only the old cold open; nothing throws.
 */

import type { KeyValueStorage } from '../cache/persisted-query-cache';
import { SESSION_LOG_COPY } from '../session-log/saved-log';
import type { SessionLogPage } from '../session-log/source';
import type { CopyCodec, CopyStore, StoredCopy } from './copy-store-types';
import { VERSION, createSavedCopyIndex, isPromise, then, type IndexEntry } from './saved-copy-index';

export interface SavedCopyStoreOptions {
  storage: KeyValueStorage;
  /** The signed-in user. Only this user's copies are read or written. */
  userId: string;
  /** How many sessions to keep. Default: 12. */
  maxSessions?: number;
  /** Upper bound of all copies together, in UTF-16 code units. Default: 1,500,000. */
  maxBytes?: number;
  /**
   * Upper bound of one session's copy, in UTF-16 code units. A larger page
   * keeps its newest messages that fit (`has_more: true`) and pages the rest
   * from the server; one whose newest message alone does not fit is not kept.
   * Default: 300,000.
   */
  maxEnvelopeBytes?: number;
  /** A copy older than this is not painted. Default: 14 days. */
  maxAgeMs?: number;
  /** Storage key prefix. Copies live under `<namespace>.log`. Default: `kortix.saved-copy`. */
  namespace?: string;
  now?: () => number;
}

export interface SavedCopyStore {
  /** The storage key of one session's copy: `<namespace>.log:<user>:<project>/<session>`. */
  keyFor(projectId: string, sessionId: string): string;
  /** The last saved page, synchronously when the storage is synchronous. */
  read(projectId: string, sessionId: string): SessionLogPage | null | Promise<SessionLogPage | null>;
  /**
   * Keep `page` (the newest page of the session log's root thread) as this
   * session's copy. A page that cannot be painted (invalid, or no messages)
   * removes the copy instead: the server no longer vouches for one.
   */
  write(projectId: string, sessionId: string, page: SessionLogPage): Promise<void>;
  remove(projectId: string, sessionId: string): Promise<void>;
  /** Forget every copy of this user. */
  clear(): Promise<void>;
}

const DEFAULT_MAX_SESSIONS = 12;
const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_MAX_ENVELOPE_BYTES = 300_000;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_NAMESPACE = 'kortix.saved-copy';

/**
 * The v1 transcript window an SDK before the session-log major kept under `<namespace>:`.
 * Never painted: a read deletes it, and `write`, `remove` and `clear` delete it too, so a
 * device frees the space without a migration.
 */
const RETIRED_V1_COPY: CopyCodec<never> = {
  paintable: (_value): _value is never => false,
  fit: () => null,
  capturedAt: () => 0,
};

/**
 * The device's store of saved session-log pages, under `<namespace>.log`. It also deletes the
 * v1 copies an older SDK kept under `<namespace>` (`RETIRED_V1_COPY`).
 */
export function createSavedCopyStore(options: SavedCopyStoreOptions): SavedCopyStore {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const pages = createCopyStore({ ...options, namespace: `${namespace}.log` }, SESSION_LOG_COPY);
  const retired = createCopyStore({ ...options, namespace }, RETIRED_V1_COPY);
  return {
    keyFor: pages.keyFor,
    read: pages.read,
    write: async (projectId, sessionId, page) => {
      await pages.write(projectId, sessionId, page);
      await retired.remove(projectId, sessionId);
    },
    remove: async (projectId, sessionId) => {
      await Promise.all([pages.remove(projectId, sessionId), retired.remove(projectId, sessionId)]);
    },
    clear: async () => {
      await Promise.all([pages.clear(), retired.clear()]);
    },
  };
}

function createCopyStore<T>(options: SavedCopyStoreOptions, codec: CopyCodec<T>): CopyStore<T> {
  const {
    storage,
    userId,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    namespace = DEFAULT_NAMESPACE,
    now = () => Date.now(),
  } = options;
  const prefix = `${namespace}:${userId}:`;
  const index = createSavedCopyIndex({ storage, prefix, maxSessions, maxBytes, now });
  const { indexKey, safeGet, safeRemove, enqueue, loadIndex, saveIndex, evict, touch, forgetScope } =
    index;
  const keyFor = (projectId: string, sessionId: string) => `${prefix}${projectId}/${sessionId}`;

  /** Starts the removal now, so a synchronous store has forgotten the key on return. */
  const removeNow = (key: string): void => {
    try {
      const removal = storage.removeItem(key);
      if (isPromise<void>(removal)) removal.catch(() => undefined);
    } catch {
      // Nothing to forget.
    }
  };

  return {
    keyFor,

    read(projectId, sessionId) {
      const scope = `${projectId}/${sessionId}`;
      return then(safeGet(keyFor(projectId, sessionId)), (raw) => {
        if (!raw) return null;
        let stored: StoredCopy<T>;
        try {
          stored = JSON.parse(raw) as StoredCopy<T>;
        } catch {
          removeNow(keyFor(projectId, sessionId));
          void forgetScope(scope);
          return null;
        }
        if (
          !stored ||
          stored.v !== VERSION ||
          stored.user !== userId ||
          now() - stored.at > maxAgeMs ||
          !codec.paintable(stored.e)
        ) {
          removeNow(keyFor(projectId, sessionId));
          void forgetScope(scope);
          return null;
        }
        touch(scope);
        return stored.e;
      });
    },

    write(projectId, sessionId, envelope) {
      const scope = `${projectId}/${sessionId}`;
      if (!codec.paintable(envelope)) return forgetScope(scope);
      const stored: StoredCopy<T> = { v: VERSION, user: userId, at: now(), e: envelope };
      const text = codec.fit(stored, maxEnvelopeBytes);
      if (text === null) return forgetScope(scope);
      const captured = codec.capturedAt(envelope);
      return enqueue(async () => {
        const entries = await loadIndex();
        const existing = entries.find((entry) => entry.s === scope);
        if (existing && captured > 0 && existing.c > captured) return;
        const others = entries.filter((entry) => entry.s !== scope);
        const entry: IndexEntry = { s: scope, b: text.length, u: now(), c: captured };
        let kept = await evict([...others, entry], scope);
        const key = keyFor(projectId, sessionId);
        try {
          await storage.setItem(key, text);
        } catch {
          // Full: free the least recent copy and try once more.
          const oldest = kept.filter((candidate) => candidate.s !== scope).sort((a, b) => a.u - b.u)[0];
          if (oldest) {
            await safeRemove(`${prefix}${oldest.s}`);
            kept = kept.filter((candidate) => candidate.s !== oldest.s);
          }
          try {
            await storage.setItem(key, text);
          } catch {
            await safeRemove(key);
            kept = kept.filter((candidate) => candidate.s !== scope);
          }
        }
        await saveIndex(kept);
      });
    },

    remove(projectId, sessionId) {
      return forgetScope(`${projectId}/${sessionId}`);
    },

    clear() {
      return enqueue(async () => {
        const entries = await loadIndex();
        for (const entry of entries) await safeRemove(`${prefix}${entry.s}`);
        await safeRemove(indexKey);
      });
    },
  };
}

let currentStore: SavedCopyStore | null = null;

/**
 * The store the session log paints from and writes to. The host sets it
 * when a user signs in and sets `null` on sign-out (after `clear()`), because
 * only the host knows who is signed in. With no store, opening a session
 * behaves exactly as before: nothing is read or written on the device.
 */
export function setSavedCopyStore(store: SavedCopyStore | null): void {
  currentStore = store;
}

export function currentSavedCopyStore(): SavedCopyStore | null {
  return currentStore;
}
