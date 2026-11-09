/**
 * Rate-limit marked dead-credential refusals by method, normalized route,
 * status and reason, and ship the throttled line at a severity that follows
 * the window's volume. Responses and emitted message text stay unchanged.
 * A ten-minute window permits six lines per route/reason per process per hour.
 * Suppression counts are best-effort: they appear only on the next warning.
 * A final quiet burst, eviction or process restart can lose pending counts;
 * use request-completion logs or auth audits for exact refusal accounting.
 */
import { HTTPException } from 'hono/http-exception';

const WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_MESSAGES = 10_000;

/**
 * The suppressed count at which a throttled refusal line ships at `warn`
 * instead of `info` (KRTX-4454). The steady state of this class is DESIGNED
 * churn: every session stop leaves its box probing with a dead credential,
 * 1-2 refusals per stop, forever — so the window trips forever and a flat
 * warn level keeps a 0-baseline warn pattern alive that re-trips the
 * infra-sweep's new-pattern detector every time (~10 lines/h on the
 * audit-events route, 2026-11-07). Measured prod steady state: a pending
 * count of 0-4 per route/reason per replica window; the KRTX-1039 storm ran
 * ~200. Above this band is a caller ignoring the typed stop code — that
 * stays warn.
 */
export const DEAD_CREDENTIAL_BURST_SUPPRESSED = 10;

const UUID_PATTERN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

/**
 * The throttle bucket key for a dead-credential refusal: method, route,
 * status and a reason with every token id normalized OUT. KRTX-1564 named the
 * dead row in the refusal (`project token <id> is revoked`); keyed verbatim,
 * every revoked token would open its own bucket and the per-route/reason
 * window this limiter exists for (the KRTX-1039 warn spike) would shard into
 * one-bucket-per-token noise. The printed LINE keeps the id — only the bucket
 * key hides it.
 */
export function deadCredentialLogKey(method: string, path: string, status: number, reason: string): string {
  return `${method} ${path} ${status} ${reason}`.replace(UUID_PATTERN, ':id');
}

const deadCredentials = new WeakSet<HTTPException>();

type Window = { loggedAt: number; suppressed: number };
// replica-local: a log-noise limiter; each replica rate-limits its own lines.
const windows = new Map<string, Window>();

/** Mark an exception as a dead-credential refusal. Called by
 *  `deadCredential401`, the one constructor every gate that refuses a
 *  credential that cannot come back throws — PAT/secret-key auth and the
 *  per-account session gate alike. */
export function markDeadCredential(err: HTTPException): void {
  deadCredentials.add(err);
}

/**
 * Stable error code a gate's 401 carries when the presented credential can
 * never come back: missing, revoked, expired, its sandbox lease closed, or
 * the session the per-account session policy revoked. The body keeps the
 * global `{error, message, status}` shape and adds this `code`, so a
 * retrying client can branch on it and stop instead of hammering the gate
 * forever — prod 2026-09-26/27: one fleet of boxes that outlived their
 * session credential produced ~10k 401s/h across
 * `/v1/platform/runtime-projection`, `/turn-stream` and `/audit/events`,
 * every one a plain untyped 401 no client could tell apart from a transient
 * one. Mirrors the typed-error pattern of `buildDenialError`
 * (`code:'account_mfa_required'`) and `impersonation.ts`
 * (`code:'impersonation_invalid'`): an HTTPException built with an explicit
 * `res` is returned verbatim by the global error handler
 * (apps/api/src/index.ts), so the body arrives untyped nowhere.
 * Consumers: apps/kortix-sandbox-agent-server's `session-token-health.ts`
 * breaker classifies the body; the SDK's ApiError lifts `code` from error
 * bodies. Keep the string in sync with that breaker.
 */
export const SESSION_TOKEN_REVOKED_CODE = 'session_token_revoked';

/**
 * Build the typed dead-credential 401: a credential that can never come
 * back. The gates that refuse one (PAT/secret-key auth, the per-account
 * session gate) call this so the body carries
 * `code: 'session_token_revoked'` and the global error handler
 * rate-limits the warn line. Every consumer keeps its own refusal message;
 * the code is the shared contract.
 */
export function deadCredential401(message: string): HTTPException {
  const err = new HTTPException(401, {
    message,
    res: new Response(
      JSON.stringify({ error: true, message, status: 401, code: SESSION_TOKEN_REVOKED_CODE }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });
  // The body above already tells a reading client to stop. One that does not
  // (an in-sandbox agent CLI retrying per step) would otherwise put one warn
  // line per refusal into the API log — the KRTX-1039 spike. The mark routes
  // this exception through the global error handler's log throttle without
  // touching the response.
  markDeadCredential(err);
  return err;
}

/** True for an exception `markDeadCredential` marked. */
export function isDeadCredential(err: HTTPException): boolean {
  return deadCredentials.has(err);
}

/**
 * The 401 message `resolveJwt` throws when a presented Supabase JWT fails
 * verification (expired, bad signature, malformed) or rejects at the network
 * fallback. Shared verbatim between every throw site and the error handler,
 * so the throttle below cannot silently drift from what is thrown.
 */
export const INVALID_OR_EXPIRED_TOKEN_MESSAGE = 'Invalid or expired token';

/**
 * True for the plain 401 `resolveJwt` throws for a Supabase JWT that does not
 * verify. Unlike a deadCredential401 the credential CAN come back (a
 * refresh), so the response stays untouched — but a client that neither
 * refreshes nor stops turns every refusal into a warn line (KRTX-4442: 78
 * lines in one hour on GET /v1/auth/user, one external client retrying an
 * expired JWT every few seconds). Route the LINE through the same per-route
 * window throttle; the reason already differs from every dead-credential
 * refusal, so the buckets stay separate, and `auditLoginFail` at the throw
 * site keeps exact per-request accounting.
 */
export function isInvalidExpiredTokenRefusal(status: number, reason: string): boolean {
  return status === 401 && reason === INVALID_OR_EXPIRED_TOKEN_MESSAGE;
}

/** First warning logs immediately; the next window reports pending suppression. */
export function deadCredentialLogDecision(key: string, now: number): { log: boolean; suppressed: number } {
  const window = windows.get(key);
  if (window && now - window.loggedAt < WINDOW_MS) {
    window.suppressed += 1;
    return { log: false, suppressed: 0 };
  }
  const suppressed = window?.suppressed ?? 0;
  if (!window && windows.size >= MAX_TRACKED_MESSAGES) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  windows.set(key, { loggedAt: now, suppressed: 0 });
  return { log: true, suppressed };
}

/** Test seam. */
export function resetDeadCredentialLogForTests(): void {
  windows.clear();
}
