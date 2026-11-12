/**
 * Reading the truth out of a wrapped error. No imports — every module that
 * needs this is one a database module must be able to depend on, or one that
 * must stay database-free. A leaf keeps both true.
 *
 * The rule this encodes (learnings, 2026-09-10): a wrapper error hides its
 * cause, so never read `.message`. `DrizzleQueryError.message` is the whole
 * generated statement plus its bound parameters; the SQLSTATE that says what
 * actually failed is on `.cause`.
 */

/**
 * The cause chain as nodes: `error` itself first, then each `.cause` link.
 * Every field a classifier reads is an optional `unknown`, because a thrown
 * value can be anything.
 *
 * Bounded and cycle-safe. These run on an error path, where a hang is the worst
 * possible outcome — worse than a missing detail — so the walk refuses to
 * revisit a node and gives up after `maxDepth` links (16 by default; a
 * classifier whose own walk differed before the consolidation passes its
 * bound — `postgres-errors.ts` walks 4 links, `database-errors.ts` 8, and
 * `isAuditContentionError` walked acyclic chains with no cutoff at all, so it
 * passes `Infinity` and leans on the revisit guard to terminate).
 *
 * Lazy: a node's `cause` is read only when the consumer pulls the NEXT node,
 * so a classifier that returns at a match — the trunk's `errorSqlstate`,
 * `isUniqueViolation`, `uniqueViolationConstraint` and `isAuditContentionError`
 * all stopped there — never reads past it, and a throwing `cause` getter below
 * a matched code cannot break the match. A consumer that needs the whole chain
 * materializes it (`Array.from`), reading every link up to the bound.
 *
 * The one walk every classifier reads (`errorSqlstate`'s first code,
 * `innermostMessage`'s deepest message, the transient sets over every node,
 * the driver-node find), so "what does this chain say" has one answer.
 */
export function* errorChain(error: unknown, maxDepth = 16): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let node = error;
  for (let depth = 0; depth < maxDepth && node != null && typeof node === 'object' && !seen.has(node); depth++) {
    seen.add(node);
    yield node as Record<string, unknown>;
    node = (node as { cause?: unknown }).cause;
  }
}

/**
 * The first `code` found walking down the cause chain.
 *
 * FIRST, not deepest, and deliberately so: this is the behaviour
 * `auditErrorSqlstate` has had in production, and it decides whether an audit
 * write is retried. Drizzle's wrapper carries no `code`, so the first hit is
 * the driver's SQLSTATE anyway; the two rules only diverge for an error that
 * synthesises its own code above a driver error, and in that case the outer
 * code is the one the thrower meant us to act on.
 */
export function errorSqlstate(error: unknown): string | null {
  for (const node of errorChain(error)) {
    const code = node.code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

/**
 * Complement to a consistent lock order (never a substitute): a deadlock victim (40P01) rolled back
 * whole, so re-running the idempotent transaction is safe. Two retries, short
 * jittered backoff; any other error, or the third deadlock, propagates.
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 3 || errorSqlstate(err) !== '40P01') throw err;
      await Bun.sleep(50 * attempt + Math.random() * 50);
    }
  }
}

/**
 * Deepest `message` on the chain. Drizzle wraps the driver error, and it is the
 * driver's message ("canceling statement due to statement timeout") that names
 * the fault.
 */
export function innermostMessage(error: unknown): string | null {
  let found: string | null = null;
  for (const node of errorChain(error)) {
    const message = node.message;
    if (typeof message === 'string' && message.length > 0) found = message;
  }
  return found;
}

/**
 * PostgreSQL SQLSTATEs that mean "another writer holds what this one needs",
 * not "this write is wrong".
 *
 * Until 2026-10 `audit_prepare_event` serialized every row of a session behind
 * one `audit_session_sequences` row lock held to COMMIT; the lock is gone, but a
 * slow INSERT on the audit pool still surfaces as 57014 (statement_timeout, the
 * SampleCo signature: 445 x 500 in 3h, each at ~10s) or 55P03 at the pool's
 * `lock_timeout`, e.g. behind DDL. Callers must report
 * these as retryable backpressure, never as a 500 or a silent drop: a 500
 * makes the sandbox relay retry a batch that has already been rejected, and a
 * drop just loses the events (prod, 2026-09-24 through 2026-09-27: hundreds of
 * "[audit] Dropped a batch" per hour, 100% sqlstate=55P03).
 *
 * Lives here, not in `audit-db.ts`: that module `import`s `./db`, which builds
 * a real connection pool at module scope, so anything that imports it can no
 * longer be database-free. `audit-queue.ts`'s flush path must stay
 * database-free (its own tests mock `@kortix/db` without a live pool), so the
 * classifier — like `errorSqlstate` above — lives in this leaf and is
 * re-exported from `audit-db.ts` for its existing callers.
 *
 * This table is the audit classifier's membership alone. The database read
 * retry (`isTransientDatabaseError`) keeps its own table below: a code added
 * for one retry policy must never silently widen the other.
 */
const AUDIT_CONTENTION_SQLSTATES = new Set([
  '57014', // query_canceled — statement_timeout fired while queued on a lock
  '55P03', // lock_not_available — lock_timeout fired
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  // ── The database went away, which is also not "this write is wrong". ──
  //
  // A restart, failover or connection recycle is the single largest source of
  // audit write failures in production: `PostgresError: the database system is
  // shutting down`, 21,102 exceptions across 244 users since 2026-07-04, of
  // which 19,193 landed on ONE day (2026-08-14) and 142 in a 90-second window
  // on 2026-09-09. Each one threw, answered 500, and dropped the batch — and a
  // 500 is precisely what makes the sandbox relay re-send a batch on its flat
  // retry, which is how the convoy re-forms after every restart.
  //
  // Retrying is the correct client behaviour for all of these: the batch is
  // still in the relay's spool and the database is coming back. Answering 503
  // with `Retry-After` says exactly that. Only errors that describe the DATA
  // (a constraint, a bad value, a type) stay 500 — those must keep paging,
  // because retrying them can never work.
  '57P01', // admin_shutdown — "terminating connection due to administrator command"
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — "the database system is shutting down/starting up"
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure — includes CONNECTION_CLOSED / ECONNREFUSED
  '53300', // too_many_connections
]);

/**
 * Connection-class failures do not always carry a SQLSTATE.
 *
 * `postgres.js` raises `CONNECTION_CLOSED` / `CONNECTION_ENDED` and Node raises
 * `ECONNREFUSED` / `ECONNRESET` as `code` values that are not SQLSTATEs at all,
 * and prod carries all of them (`connect ECONNREFUSED <db_ip>:5432`, `write
 * CONNECTION_CLOSED db.…supabase.co:5432`). They mean the same thing as 08006
 * and must be retryable for the same reason.
 */
const AUDIT_TRANSIENT_DRIVER_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * The database read retry's own transient set: the codes
 * `isTransientDatabaseError` (database-errors.ts) retried before 2026-11,
 * kept as its own table rather than merged into the audit pair above — a
 * code added for one retry policy must never silently widen the other. The
 * `08…` connection SQLSTATEs need no entry (that classifier's
 * `startsWith('08')` rule covers them); `EMAXCONNSESSION` is the
 * session-mode pool's max clients.
 */
export const TRANSIENT_DATABASE_CODES: ReadonlySet<string> = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  // postgres.js connection-phase failure: the connection never established,
  // so the statement never reached the server (plain Error, driver's own
  // code — not a SQLSTATE). Reads may be retried.
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
  'EMAXCONNSESSION',
]);

/**
 * True when a failed audit write is backpressure (retry it) rather than a
 * defect (dead-letter it). Checks EVERY node's own code against the
 * contention sets, not only the first code found on the chain — a synthetic
 * wrapper code that itself isn't in either set must not shadow a genuinely
 * contended cause underneath it.
 *
 * Walks the chain with no depth cutoff (`Infinity`): the pre-consolidation
 * classifier recursed down `.cause` until the chain ran out, so a deeply
 * wrapped contention code must still classify — a truncated walk would make
 * `AuditQueue.flush` dead-letter backpressure instead of requeueing it. The
 * shared walk's revisit guard (not a depth bound) terminates a cause cycle.
 */
export function isAuditContentionError(error: unknown): boolean {
  for (const node of errorChain(error, Infinity)) {
    const code = node.code;
    if (typeof code === 'string' && (AUDIT_CONTENTION_SQLSTATES.has(code) || AUDIT_TRANSIENT_DRIVER_CODES.has(code))) return true;
  }
  return false;
}
