/**
 * Mark the refusals the global error handler rate-limits and ships at a
 * severity that follows the window's volume: dead credentials, agent-grant
 * denials, MFA step-up denials, credential-fence denials, keyed by method,
 * normalized route, status and reason. The window limiter itself is
 * shared/log-window.ts (a ten-minute window, six lines per key per process
 * per hour; suppression counts are best-effort) and caps the severity
 * escalation at one warn per key per hour (KRTX-4674's residual: an hour of
 * grinding past the burst band shipped every window's line at warn and
 * re-tripped the infra-sweep's new-pattern bar). Responses and emitted
 * message text stay unchanged.
 */
import { HTTPException } from 'hono/http-exception';

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
 * stays warn, at most one line per key per hour (log-window.ts's hourly warn
 * cap, KRTX-4674: the escalation is replica-local and per window, and a
 * heavy hour shipped 16/15/15 warns per route across three replicas — over
 * the sweep's 10/h bar).
 */
export const DEAD_CREDENTIAL_BURST_SUPPRESSED = 10;

const UUID_PATTERN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

/** Same treatment as UUID_PATTERN: a sandbox proxy path carries the box's
 *  `sbx_` external id, and one box per bucket would shard a fleet-wide grind
 *  (or every polled dead box) into a warn line per box (KRTX-4768). The
 *  printed line keeps the id. */
const SANDBOX_EXTERNAL_ID_PATTERN = /sbx_[0-9a-z]+/gi;

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
  return `${method} ${path} ${status} ${reason}`
    .replace(UUID_PATTERN, ':id')
    .replace(SANDBOX_EXTERNAL_ID_PATTERN, ':sandbox');
}

const deadCredentials = new WeakSet<HTTPException>();

// Same throttle, second mark: the agent-grant denial family (below).
const agentGrantDenials = new WeakSet<HTTPException>();

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
 * Mark an exception as an agent-grant denial: a stable, caller-actionable
 * refusal of the agent principal itself (the kortix_permissions grant, the
 * agent ceiling, an agent-only action, a service-account role). The response
 * already names the remedy in its typed body (`buildDenialError`), so a
 * caller that cannot or will not act on it — an in-sandbox agent looping a
 * denied command — receives the SAME refusal forever, and per-request logging
 * turns its loop into a warn storm (KRTX-4635: one prod lane, 590 lines in
 * two hours on one route, 8.8k in eight days across ~10 routes). The mark
 * routes the LINE through the shared window throttle without touching the
 * response, exactly as `deadCredential401` does for a dead credential.
 * Called by `buildDenialError`, the one constructor every such refusal throws.
 */
export function markAgentGrantDenial(err: HTTPException): void {
  agentGrantDenials.add(err);
}

/** True for an exception `markAgentGrantDenial` marked. */
export function isAgentGrantDenial(err: HTTPException): boolean {
  return agentGrantDenials.has(err);
}

// KRTX-4674: an account whose "Require MFA" policy is on refuses every aal1
// browser session until its person completes the step-up. The caller that
// polls through the refusal — the web app's workspace panels refetch the
// sessions/triggers lists every few seconds — receives the SAME typed 403
// forever, and per-request logging turned that loop into a warn storm
// (700+ lines in one hour across three list routes, 0 in the 24 h before).
const accountMfaDenials = new WeakSet<HTTPException>();

/**
 * Mark an exception as an account-MFA step-up denial: the account-wide
 * "Require MFA" policy refused an aal1 session. The response already tells
 * the client what to do (`code:'account_mfa_required'`, the web app's
 * step-up dialog keys on it), so a caller that cannot or will not act on it
 * receives the SAME refusal forever. The mark routes the LINE through the
 * shared window throttle without touching the response, exactly as
 * `markAgentGrantDenial` does. Called by `buildDenialError`'s
 * `account_mfa_required` branch, the one constructor every such refusal
 * throws. The sibling actionable denial `sso_required` keeps its
 * per-request line until a log pattern shows a caller looping on it.
 */
export function markAccountMfaDenial(err: HTTPException): void {
  accountMfaDenials.add(err);
}

/** True for an exception `markAccountMfaDenial` marked. */
export function isAccountMfaDenial(err: HTTPException): boolean {
  return accountMfaDenials.has(err);
}

// KRTX-4731: the credential fence's refusal (middleware/workspace-binding.ts,
// thrown by `enforceTokenProjectScope` — the one constructor every fence
// refusal goes through) is a designed denial: the fence is fail closed by
// route table, and the typed 403 body names the remedy
// (code credential_fence_refused, the check, "use a personal key or sign
// in"). A caller that cannot or will not act on it — an OAuth workspace
// token looping POST /v1/mcp — receives the SAME refusal forever, and
// per-request logging turned that loop into a warn storm with a 0 baseline
// (prod 2026-11-11: 31 warn lines in one hour on POST /v1/mcp, 0 in the 24 h
// before). The mark routes the LINE through the shared window throttle
// without touching the response, exactly as markAgentGrantDenial does. The
// mark covers every check the fence reports (person-route, platform-route,
// cross-workspace, …): a probing storm still escalates to warn above the
// churn band — severity follows the volume.
const credentialFenceDenials = new WeakSet<HTTPException>();

/**
 * Mark an exception as a credential-fence denial. Called by
 * `enforceTokenProjectScope`, so every fence refusal shares it.
 */
export function markCredentialFenceDenial(err: HTTPException): void {
  credentialFenceDenials.add(err);
}

/** True for an exception `markCredentialFenceDenial` marked. */
export function isCredentialFenceDenial(err: HTTPException): boolean {
  return credentialFenceDenials.has(err);
}

/**
 * The 403 message `combinedAuth` throws when a valid caller is refused a
 * preview sandbox proxy route: the sandbox's `session_sandboxes` row is gone
 * (every session stop deletes it) or the caller is not a member of the box's
 * account. `assertPreviewSandboxAccess` at the proxy route throws the same
 * message with a `, userId: …, sandboxId: …` suffix, so the family matches
 * the prefix. The web client polls the runtime surface of the session it has
 * open every 5 s, and a box that died while its session row still reads
 * `running` is refused forever — per-request logging turned one open tab on
 * one dead box into 89 warn lines in an hour against a 1.58/h baseline
 * (KRTX-4768). The response stays a plain untyped 403: the refusal is
 * correct, and unlike a dead credential the state CAN come back (a new box
 * on the next session open), so there is no typed stop code to add — only
 * the line is throttled.
 */
export const PREVIEW_SANDBOX_DENIED_MESSAGE = 'Not authorized to access this sandbox';

/** True for the plain and the route-level suffixed form of the message. */
export function isPreviewSandboxDenied(status: number, reason: string): boolean {
  return status === 403 && reason.startsWith(PREVIEW_SANDBOX_DENIED_MESSAGE);
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
