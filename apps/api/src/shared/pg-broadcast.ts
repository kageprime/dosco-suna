/**
 * Telling every api process that a project's base branch moved.
 *
 * WHY THIS EXISTS. `turn-start-convergence.ts` memoizes the desired release per
 * `(project, base ref, agent, access, owner)` so a current box pays nothing on
 * the turn path. `notifyBaseBranchMoved` drops that memo — in the process that
 * handled the push. Dev runs two API pods behind one load balancer, so the
 * OTHER pod kept serving a release resolved before the push for up to
 * `DESIRED_TTL_MS`, and the gate answered `current` for a box that was behind.
 * That is DEF-DEV-1's enabling cause. Shortening the TTL narrows the window and
 * never closes it.
 *
 * WHY LISTEN/NOTIFY. The database is the one thing every api process already
 * holds a connection to, and the event is tiny, rare and idempotent — a dropped
 * one costs exactly one resolve. `pg_notify` from the writer is one statement
 * on the pool the write already used; the subscriber is one extra connection
 * per process, opened once.
 *
 * WHY A DEDICATED CONNECTION. `sql.listen()` takes a connection out of the pool
 * for the lifetime of the subscription. Taken from the request pool that is one
 * fewer connection for traffic, and a pool hiccup would take the subscription
 * with it. This opens its own `max: PG_BROADCAST_POOL_MAX` (1) client instead.
 * It is a long-lived, per-task connection: `database-capacity.ts` must count it
 * in the rolling-deployment ceiling (2026-09-27 incident — it didn't).
 *
 * IT IS AN OPTIMISATION, NEVER AN AUTHORITY. Every failure — a pooler that does
 * not speak LISTEN, a dropped connection, a malformed payload — degrades to the
 * behaviour before it existed: the local drop plus the TTL. Nothing here may
 * throw into a caller.
 */

import { requiresTls } from '@kortix/db';
import postgres from 'postgres';
import { config } from '../config';
import { PG_BROADCAST_POOL_MAX } from './database-capacity';
import { isUuid } from './validate';
import type { DesiredInvalidationTransport } from '../projects/lib/turn-start-convergence';

/** One channel, one event: "this project's base branch moved". */
export const BASE_MOVE_CHANNEL = 'kortix_config_base_moved';

/**
 * A second channel on the SAME connection: "a tunnel RPC forward row changed"
 * (`tunnel/core/cluster-forwarder.ts`). The payload is one id and nothing else:
 * the target replica's instance id for a new row, the request id for a result.
 * The writer sends it with `pg_notify` inside the statement that writes the
 * row, on the request pool, so this module opens no connection for it.
 */
export const TUNNEL_FORWARD_CHANNEL = 'kortix_tunnel_rpc_forward';

/**
 * A third channel: "this lifecycle command left `running`". A database trigger
 * (migration 20261003101600100) sends it for every writer, so the payload is
 * one command id. Waiters in this process wake on it; see
 * `waitForLifecycleCommandSettle`.
 */
export const LIFECYCLE_COMMAND_SETTLED_CHANNEL = 'kortix_lifecycle_command_settled';

/**
 * A fourth channel: "a lifecycle command is queued, due at this epoch ms". A
 * database trigger (migration 20261006135526223) sends it for every writer.
 * The drain worker schedules itself for that moment; see
 * `onLifecycleCommandDue`.
 */
export const LIFECYCLE_COMMAND_DUE_CHANNEL = 'kortix_lifecycle_command_due';

/**
 * A fifth channel: "this session's prompt inbox changed". A database trigger
 * (migration 20261006151556632) sends it for every writer of a
 * `continue_session` row, so the payload is one session id. The control
 * reconciler re-reads that session's queue now; see `onSessionPromptsChanged`.
 */
export const SESSION_PROMPTS_CHANGED_CHANNEL = 'kortix_session_prompts_changed';

/**
 * A sixth channel: "this session's box or title changed". Database triggers
 * (migration 20261007140000000) send it for every writer of a client-visible
 * `session_sandboxes` field (status, external id, live turns, wake fields) and
 * of the session title. The payload is one session id. The control reconciler
 * re-reads that session now, and `/events` streams waiting for a box wake; see
 * `onSessionChanged` and `waitForSessionChange`.
 */
export const SESSION_CHANGED_CHANNEL = 'kortix_session_changed';

/**
 * A seventh channel: "drop this principal's or project's cached authz entries".
 * Payload `user:<uuid>` or `project:<uuid>`. `iam/cache-invalidation.ts` sends
 * it after every revoke-side bust, so a demotion on one replica reaches the
 * in-memory authz memos of every other replica at once instead of after the
 * 15 s TTL. See `publishIamCacheBust` and `onIamCacheBust`.
 */
export const IAM_CACHE_BUST_CHANNEL = 'kortix_iam_cache_bust';

/**
 * An eighth channel: "drop this project's cached private-channel access".
 * Payload: one project id. `bustSpaceAccess` (`shared/space-access.ts`) sends
 * it after a membership change, a private create or a conversion, so every
 * replica drops its access memo and re-checks its open streams at once
 * instead of after the 10 s TTL. See `publishSpaceAccessBust`.
 */
export const SPACE_ACCESS_BUST_CHANNEL = 'kortix_space_access_bust';

/**
 * A ninth channel: "drop this project's memoized session-list ETags".
 * Payload: one project id. `forgetSessionListPollEtags`
 * (`projects/lib/session-list-poll-memo.ts`) sends it after every session
 * write, so a revalidation that lands on another replica than the write gets
 * the new list, not a 304 from before it.
 */
export const SESSION_LIST_BUST_CHANNEL = 'kortix_session_list_bust';

/**
 * A tenth channel: "send this frame to a Kortix in Chrome extension". The
 * payload is `{"chromeId","frame"}`, always under 8 KB. The replica that holds
 * the extension's control socket delivers it; see `chrome/registry.ts`.
 */
export const CHROME_COMMAND_CHANNEL = 'kortix_chrome_cmd';

let listener: postgres.Sql | null = null;
// `bun --hot` re-evaluates this module but keeps globalThis. The last evaluation's
// stop lives there, so a re-evaluated start ends that LISTEN client first instead
// of orphaning it (postgres.js re-LISTENs on reconnect, so an orphan never dies).
const hot = globalThis as typeof globalThis & { __kortixPgBroadcastStop?: () => Promise<void> };
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const LISTEN_RETRY_MS = 60_000;

function invokeSubscriber<T>(handler: ((arg: T) => void) | null | undefined, arg: T): void {
  try {
    handler?.(arg);
  } catch {
    // A subscriber must not take the listener down.
  }
}

// replica-local: a waiter waits in this process; the NOTIFY reaches every replica.
const settleWaiters = new Map<string, Set<() => void>>();

/**
 * Resolves when `commandId` leaves `running` (any replica's write) or after
 * `ms`, whichever is first. Register BEFORE reading the row: a settle that
 * lands between the read and the wait still wakes it. Without the LISTEN it is
 * a plain timer, so a caller passes its old poll interval then.
 */
export function waitForLifecycleCommandSettle(commandId: string, ms: number): { done: Promise<void>; cancel: () => void } {
  let wake = () => {};
  const done = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const waiters = settleWaiters.get(commandId) ?? new Set();
  settleWaiters.set(commandId, waiters);
  waiters.add(wake);
  const timer = setTimeout(wake, Math.max(0, ms));
  const cancel = () => {
    clearTimeout(timer);
    waiters.delete(wake);
    if (waiters.size === 0 && settleWaiters.get(commandId) === waiters) settleWaiters.delete(commandId);
    wake();
  };
  void done.then(cancel);
  return { done, cancel };
}

// ——— The channel registry ———

/** Validate a payload that must be one uuid (a project or session id). Anything
 * else on the channel is not ours; dropping it costs a TTL window, acting on
 * it would not. */
function parseUuid(payload: string): string | null {
  return isUuid(payload) ? payload : null;
}

/** Validate a payload that must be one finite number (an epoch ms). */
function parseFiniteNumber(payload: string): number | null {
  const dueAtMs = Number(payload);
  return Number.isFinite(dueAtMs) ? dueAtMs : null;
}

/** A payload passed through unvalidated (a command or request id, an instance id, a frame). */
function parseRaw(payload: string): string | null {
  return payload;
}

/** A channel's subscriber slot: the single handler the `on*` setter registered
 * (`set(null)` clears it) or a fan-out — every registration gets the value,
 * each isolated (a throw never stops the next). The fan-out keeps each
 * channel's trunk delivery loop: the base-move transport's array was iterated
 * live (`repeated` — the same handler registered twice runs twice, and a
 * handler registered during delivery joins that pass), the trunk Sets iterated
 * the snapshot at dispatch start (an unsubscribe during delivery is honored on
 * the next). Kept across stop/start; `clear` drops the transport's
 * subscribers. */
function slot<TArg>(repeated = false) {
  let handlers: ((value: TArg) => void)[] = [];
  return {
    set(next: ((value: TArg) => void) | null) {
      handlers = next ? [next] : [];
    },
    subscribe(handler: (value: TArg) => void) {
      if (repeated || !handlers.includes(handler)) handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at !== -1) handlers.splice(at, 1);
      };
    },
    clear() {
      // A new array, like the trunk's `handlers = []`: a live delivery already
      // iterating the old one runs to its end instead of stopping short.
      handlers = [];
    },
    dispatch(value: TArg) {
      for (const handler of repeated ? handlers : [...handlers]) invokeSubscriber(handler, value);
    },
  };
}

/** The one LISTEN body every channel runs: `parse` validates the raw NOTIFY
 * payload (null drops it) and `dispatch` hands the parsed value to the
 * channel's subscribers, never throwing. */
function wired<TValue>(entry: {
  parse: (payload: string) => TValue | null;
  dispatch: (value: TValue) => void;
}): (payload: string) => void {
  return (payload) => {
    const value = entry.parse(payload);
    if (value !== null) entry.dispatch(value);
  };
}

/** The one publish body: fire-and-forget on the LISTEN connection's own pool —
 * it runs no other statements, so a NOTIFY never queues behind request traffic.
 * The caller is inside the write and must not wait; without the LISTEN it is a
 * no-op, the caller's TTL or poll being the backstop. */
function notify(channel: string, payload: string): void {
  if (listener) void listener.notify(channel, payload).catch(() => {});
}

/** The channel registry: one entry per LISTEN channel. The `on*` setters write
 * a channel's slot, the `publish*` helpers notify its channel, and
 * startConfigBaseMoveBroadcast wires every entry with the same `wired` body,
 * in this order. */
const CHANNELS = {
  // The trunk's registry was an array here: every registration is delivered.
  baseMove: { channel: BASE_MOVE_CHANNEL, parse: parseUuid, ...slot<string>(true) },
  // The payload is one id and nothing else, passed through unvalidated.
  tunnelForward: { channel: TUNNEL_FORWARD_CHANNEL, parse: parseRaw, ...slot<string>() },
  // The payload is one command id and nothing else.
  commandSettled: {
    channel: LIFECYCLE_COMMAND_SETTLED_CHANNEL,
    parse: parseRaw,
    dispatch: (commandId: string): void => {
      for (const wake of settleWaiters.get(commandId) ?? []) wake();
    },
  },
  commandDue: { channel: LIFECYCLE_COMMAND_DUE_CHANNEL, parse: parseFiniteNumber, ...slot<number>() },
  // The payload is a session id and nothing else.
  promptsChanged: { channel: SESSION_PROMPTS_CHANGED_CHANNEL, parse: parseUuid, ...slot<string>() },
  // replica-local: subscribers in this process; the NOTIFY reaches every replica.
  sessionChanged: { channel: SESSION_CHANGED_CHANNEL, parse: parseUuid, ...slot<string>() },
  iamCacheBust: { channel: IAM_CACHE_BUST_CHANNEL, parse: parseRaw, ...slot<string>() },
  chromeCommand: { channel: CHROME_COMMAND_CHANNEL, parse: parseRaw, ...slot<string>() },
  // The payload is a project id and nothing else.
  spaceAccessBust: { channel: SPACE_ACCESS_BUST_CHANNEL, parse: parseUuid, ...slot<string>() },
  sessionListBust: { channel: SESSION_LIST_BUST_CHANNEL, parse: parseUuid, ...slot<string>() },
};

/** The drain worker registers on start. Kept across stop/start of the LISTEN. */
export function onLifecycleCommandDue(handler: ((dueAtMs: number) => void) | null): void {
  CHANNELS.commandDue.set(handler);
}

/** The control reconciler registers once, at import. Kept across stop/start. */
export function onSessionPromptsChanged(handler: ((sessionId: string) => void) | null): void {
  CHANNELS.promptsChanged.set(handler);
}

/** The chrome registry registers once, at import. Kept across stop/start. */
export function onChromeCommand(handler: ((payload: string) => void) | null): void {
  CHANNELS.chromeCommand.set(handler);
}

/**
 * Send `kortix_session_changed` for a change no trigger sees: the box's daemon
 * reporting its runtime ready (`POST /platform/boot-timeline`). Every replica's
 * waiting deliveries and `/events` streams re-check the session at once instead
 * of on their next poll. Without the LISTEN it is a no-op: the polls still run.
 */
export function publishSessionChanged(sessionId: string): void {
  if (isUuid(sessionId)) notify(SESSION_CHANGED_CHANNEL, sessionId);
}

/** Subscribe to `kortix_session_changed`. Returns the unsubscribe. Kept across stop/start. */
export function onSessionChanged(handler: (sessionId: string) => void): () => void {
  return CHANNELS.sessionChanged.subscribe(handler);
}

/**
 * Resolves when `sessionId` changes (any replica's write), after `ms`, or when
 * `signal` aborts, whichever is first. Without the LISTEN it is a plain timer,
 * so a caller passes its pre-NOTIFY poll interval then.
 */
export function waitForSessionChange(sessionId: string, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const unsubscribe = onSessionChanged((changed) => {
      if (changed === sessionId) finish();
    });
    const timer = setTimeout(finish, Math.max(0, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** `iam/cache-invalidation.ts` registers once, at import. Kept across stop/start. */
export function onIamCacheBust(handler: ((payload: string) => void) | null): void {
  CHANNELS.iamCacheBust.set(handler);
}

/** Tell every replica to drop an authz cache entry. Without the LISTEN it is a no-op: the TTL is the backstop. */
export function publishIamCacheBust(payload: string): void {
  notify(IAM_CACHE_BUST_CHANNEL, payload);
}

/** `shared/space-access.ts` registers once, at import. Kept across stop/start. */
export function onSpaceAccessBustNotify(handler: ((projectId: string) => void) | null): void {
  CHANNELS.spaceAccessBust.set(handler);
}

/** Tell every replica (this one included) to drop a project's private-channel access memo. Without the LISTEN it is a no-op: the TTL is the backstop. */
export function publishSpaceAccessBust(projectId: string): void {
  notify(SPACE_ACCESS_BUST_CHANNEL, projectId);
}

/** `projects/lib/session-list-poll-memo.ts` registers once, at import. Kept across stop/start. */
export function onSessionListBustNotify(handler: ((projectId: string) => void) | null): void {
  CHANNELS.sessionListBust.set(handler);
}

/** Tell every replica (this one included) to drop a project's session-list memo. Without the LISTEN it is a no-op: the 2 s TTL is the backstop. */
export function publishSessionListBust(projectId: string): void {
  notify(SESSION_LIST_BUST_CHANNEL, projectId);
}

/** The forwarder registers once, at import. Kept across stop/start. */
export function onTunnelForwardNotify(handler: (payload: string) => void): void {
  CHANNELS.tunnelForward.set(handler);
}

/**
 * True once this process holds the LISTEN. False means no NOTIFY can arrive
 * here, so a caller that waits on one must poll at its pre-NOTIFY rate.
 */
export function isPgBroadcastListening(): boolean {
  return listener !== null;
}

/**
 * The transport the invalidation is wired to. Subscribing before
 * `startConfigBaseMoveBroadcast` resolves is fine: handlers are held and fed by
 * whatever arrives after the LISTEN lands.
 */
export function configBaseMoveTransport(): DesiredInvalidationTransport {
  return {
    publish: (projectId) => notify(BASE_MOVE_CHANNEL, projectId),
    subscribe: (handler) => {
      CHANNELS.baseMove.subscribe(handler);
    },
  };
}

/**
 * Open the subscription. Resolves once LISTEN is established, or once it is
 * known to be impossible — never rejects.
 *
 * Until it succeeds, `publish` is a no-op and every process falls back to its
 * local drop plus the TTL, which is exactly the behaviour that shipped before.
 */
export async function startConfigBaseMoveBroadcast(): Promise<boolean> {
  if (listener) return true;
  if (!config.DATABASE_URL) return false;
  const previous = hot.__kortixPgBroadcastStop;
  hot.__kortixPgBroadcastStop = stopConfigBaseMoveBroadcast;
  if (previous && previous !== stopConfigBaseMoveBroadcast) await previous();
  try {
    const sql = postgres(config.DATABASE_URL, {
      ...(requiresTls(config.DATABASE_URL) ? { ssl: 'require' as const } : {}),
      max: PG_BROADCAST_POOL_MAX,
      // A subscription connection runs no statements of its own, so the
      // request pool's statement timeout would only be a way to lose it.
      idle_timeout: 0,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {},
    });
    // postgres.js re-issues the LISTEN itself when the connection drops and
    // comes back, so a database restart does not need handling here.
    await sql.listen(CHANNELS.baseMove.channel, wired(CHANNELS.baseMove));
    await sql.listen(CHANNELS.tunnelForward.channel, wired(CHANNELS.tunnelForward));
    await sql.listen(CHANNELS.commandSettled.channel, wired(CHANNELS.commandSettled));
    await sql.listen(CHANNELS.commandDue.channel, wired(CHANNELS.commandDue));
    await sql.listen(CHANNELS.promptsChanged.channel, wired(CHANNELS.promptsChanged));
    await sql.listen(CHANNELS.sessionChanged.channel, wired(CHANNELS.sessionChanged));
    await sql.listen(CHANNELS.iamCacheBust.channel, wired(CHANNELS.iamCacheBust));
    await sql.listen(CHANNELS.chromeCommand.channel, wired(CHANNELS.chromeCommand));
    await sql.listen(CHANNELS.spaceAccessBust.channel, wired(CHANNELS.spaceAccessBust));
    await sql.listen(CHANNELS.sessionListBust.channel, wired(CHANNELS.sessionListBust));
    listener = sql;
    console.log(
      `[config-releases] base-move broadcast listening on ${BASE_MOVE_CHANNEL}, ${TUNNEL_FORWARD_CHANNEL}, ${LIFECYCLE_COMMAND_SETTLED_CHANNEL}, ${LIFECYCLE_COMMAND_DUE_CHANNEL}, ${SESSION_PROMPTS_CHANGED_CHANNEL}, ${SESSION_CHANGED_CHANNEL}, ${IAM_CACHE_BUST_CHANNEL}, ${SPACE_ACCESS_BUST_CHANNEL}, ${SESSION_LIST_BUST_CHANNEL}, ${CHROME_COMMAND_CHANNEL}`,
    );
    return true;
  } catch (error) {
    // A transaction pooler multiplexes connections and cannot hold a LISTEN.
    // Say so once; the TTL is the backstop.
    console.warn(
      '[config-releases] base-move broadcast unavailable; the desired-release memo falls back to its TTL:',
      error instanceof Error ? error.message : String(error),
    );
    // Try again later. Until then every subscriber runs at its pre-NOTIFY rate.
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      void startConfigBaseMoveBroadcast();
    }, LISTEN_RETRY_MS);
    retryTimer.unref?.();
    return false;
  }
}

export async function stopConfigBaseMoveBroadcast(): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const sql = listener;
  listener = null;
  CHANNELS.baseMove.clear();
  if (!sql) return;
  await sql.end({ timeout: 2 }).catch(() => {});
}
