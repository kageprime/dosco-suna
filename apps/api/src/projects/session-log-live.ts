/**
 * The live read of the session log: `GET …/log?live=1` answers the running box's own newest page
 * of a thread (`GET /kortix/runtime/log`, `runtime.log.v1`). The box's page holds every message up
 * to now. The stored log lags it by the journal: pi posts every 5 s while a turn runs and at its
 * end, and backs off for minutes when the API answers 5xx or 429.
 *
 * `readLiveSessionLogPage` answers null when the stored log must answer instead, with the reason:
 *  - the session has no box that can answer (`no_sandbox`, `sandbox_<status>`): no wait;
 *  - the box did not answer a whole page within {@link SESSION_LOG_LIVE_BUDGET_MS}, address
 *    lookup included (`timeout`, `daemon_<status>`, `too_large`, `invalid_json`, `invalid_page`);
 *  - the box answered another thread (`other_thread`);
 *  - the box's page is of an older generation than the stored log (`stale_generation`): a box
 *    that was replaced, or one whose journal has not started yet;
 *  - the replica already runs as many live reads as it allows (`busy`, `createLiveReadGate`).
 * The box is never woken: a read is not a reason to run one.
 *
 * The page is passed through as the box built it, with `source: 'box'`, serialized once. The
 * client validates every record (the SDK's `isSessionLogPage`), as it did when it read the box
 * itself.
 */
import type { SessionLogPage } from '@kortix/api-contract/session-log';
import { sessionLogs, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { fetchRuntimeLogPage, type RuntimeLogPageFetch } from './lib/session-runtime-transport';

/**
 * The longest wait for the box's page. Measured on 2026-11-24 from a client through the prod API
 * to 12 running prod boxes, 3 reads each: 130–300 ms typical, 1.2 s the slowest of 36, all 200.
 */
export const SESSION_LOG_LIVE_BUDGET_MS = 2_000;

/** A box row in one of these states runs a box (`session-event-stream.ts` attaches to the same two). */
const RUNNING = new Set(['active', 'provisioning']);

/** The box's page as the JSON text the route answers (`source: 'box'`), serialized once for every caller that shares it. */
export type LiveSessionLogRead = { body: string } | { body: null; reason: string };

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A whole page: the session record, the generation, the thread heads and the thread's messages. */
function isWholePage(v: unknown): v is SessionLogPage {
  return (
    isObj(v) &&
    isObj(v.session) &&
    Number.isSafeInteger(v.generation) &&
    (v.generation as number) >= 0 &&
    Array.isArray(v.threads) &&
    typeof v.thread_id === 'string' &&
    Array.isArray(v.messages) &&
    typeof v.has_more === 'boolean'
  );
}

/**
 * Bounds the live box reads one replica runs at once. A read holds a box's answer (at most 2 MiB
 * and 50,000 structural tokens, `readRuntimeLogPageBody`) while it parses it, then only its
 * serialized text:
 *  - callers of the same key (session, thread, limit) share one read and one serialized text: a
 *    reconnect storm or many tabs of one session cost one box read and one `JSON.stringify`;
 *  - at most `maxPerSession` different reads of one session run at once;
 *  - at most `maxPerCaller` reads start for one caller: one member's stalled boxes (2 s each at
 *    worst) cannot take every slot from the other callers on the replica;
 *  - at most `maxInFlight` reads run on the replica.
 * A read past a limit answers null at once: the caller answers the stored log.
 */
export function createLiveReadGate<T>(limits: { maxInFlight: number; maxPerSession: number; maxPerCaller: number }) {
  const running = new Map<string, { sessionId: string; callerId: string; read: Promise<T> }>();
  return {
    run(key: string, sessionId: string, callerId: string, read: () => Promise<T>): Promise<T | null> {
      // Joining a running read costs no slot.
      const shared = running.get(key);
      if (shared) return shared.read;
      if (running.size >= limits.maxInFlight) return Promise.resolve(null);
      let ofSession = 0;
      let ofCaller = 0;
      for (const entry of running.values()) {
        if (entry.sessionId === sessionId) ofSession++;
        if (entry.callerId === callerId) ofCaller++;
      }
      if (ofSession >= limits.maxPerSession || ofCaller >= limits.maxPerCaller) return Promise.resolve(null);
      const started = read().finally(() => running.delete(key));
      running.set(key, { sessionId, callerId, read: started });
      return started;
    },
  };
}

export const LIVE_READ_LIMITS = { maxInFlight: 8, maxPerSession: 2, maxPerCaller: 3 } as const;

/** replica-local: the live reads this API process runs; each replica bounds its own memory. */
const liveReads = createLiveReadGate<LiveSessionLogRead>(LIVE_READ_LIMITS);

export async function readLiveSessionLogPage(input: {
  sessionId: string;
  /** Signs the user context the box sees; the sandbox service key authorizes the read. */
  userId: string | null;
  threadId: string | null;
  limit: number;
  budgetMs?: number;
}): Promise<LiveSessionLogRead> {
  const key = `${input.sessionId}\u0000${input.threadId ?? ''}\u0000${input.limit}`;
  const read = await liveReads.run(key, input.sessionId, input.userId ?? `session:${input.sessionId}`, () => readBox(input));
  return read ?? { body: null, reason: 'busy' };
}

async function readBox(input: Parameters<typeof readLiveSessionLogPage>[0]): Promise<LiveSessionLogRead> {
  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, input.sessionId))
    .limit(1);
  if (!sandbox?.externalId || !RUNNING.has(sandbox.status)) {
    return { body: null, reason: sandbox ? `sandbox_${sandbox.status}` : 'no_sandbox' };
  }
  // The budget covers the whole box read: resolving the box's address (a provider call on a cold
  // cache, up to the provider's own timeout) as well as the request to it.
  const signal = AbortSignal.timeout(input.budgetMs ?? SESSION_LOG_LIVE_BUDGET_MS);
  const timedOut = new Promise<RuntimeLogPageFetch>((resolve) =>
    signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout', status: null }), { once: true }),
  );
  const [box, stored] = await Promise.all([
    Promise.race([
      fetchRuntimeLogPage(
        { externalId: sandbox.externalId, ...(input.userId && { userId: input.userId }) },
        { thread: input.threadId, limit: input.limit },
        signal,
      ),
      timedOut,
    ]),
    db.select({ generation: sessionLogs.generation }).from(sessionLogs).where(eq(sessionLogs.sessionId, input.sessionId)).limit(1),
  ]);
  if (!box.ok) return { body: null, reason: box.reason };
  if (!isWholePage(box.body)) return { body: null, reason: 'invalid_page' };
  if (input.threadId !== null && box.body.thread_id !== input.threadId) return { body: null, reason: 'other_thread' };
  const storedGeneration = stored[0]?.generation;
  if (storedGeneration !== undefined && box.body.generation < storedGeneration) return { body: null, reason: 'stale_generation' };
  return { body: JSON.stringify({ ...box.body, source: 'box' }) };
}
