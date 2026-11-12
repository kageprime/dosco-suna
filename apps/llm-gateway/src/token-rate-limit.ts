import { createHmac, randomBytes } from 'node:crypto';
import { gatewayErrorResponse } from '@kortix/llm-gateway';
import { TokenBucketRateLimiter } from '@kortix/shared/rate-limit';

/**
 * The limit the gateway applies on every route whose handler can reach the API
 * with a caller-supplied credential (model routes, and the `/health` probe
 * that forwards a caller bearer to `authenticate`). `source` is the caller's
 * address as the trusted hop reported it (`clientIp` in the Hono env, set from
 * the socket peer in `main.ts`) — null when there is none.
 */
export type TokenRateLimit = {
  (request: Request, headers?: Headers, source?: string | null): Response | null;
  /** The API answered this credential with a principal; it keeps its own bucket from now on. */
  validated: (credential: string) => void;
  /** The live bucket keys; KRTX-4528 proves a flood of fakes leaves only the shared one. */
  buckets: () => string[];
  /** The credentials waiting for a shared-slot refund; KRTX-4528 proves a flood cannot grow it without bound. */
  chargedCount: () => number;
};

/**
 * The per-credential request limit on every model route of this service. It
 * runs before the body is read and before the admit call to the API.
 *
 * Sandboxes can call this service directly (`LLM_GATEWAY_BASE_URL` on the
 * API). Their requests then skip the API's `/v1/llm` limit. This applies the
 * same limit under the same setting, `KORTIX_LLM_GATEWAY_REQS_PER_MIN`
 * (default 600 per minute per credential).
 *
 * The limit runs before `authenticate()`, so it cannot tell a real credential
 * from a fabricated one. A credential the API has answered with a principal is
 * real and keeps its own bucket, keyed on the credential's SHA-256 so no raw
 * secret stays in memory. Every other credential spends first its own small
 * pre-validation allowance — at most 20/min, the one boundary a single caller
 * governs — and is charged to ONE shared bucket, given by `unvalidatedPerMinute`
 * (order of magnitude above one credential's own budget), whatever its value:
 * the shared allowance bounds how many requests reach the API unverified
 * (CWE-770) even though a fresh made-up bearer also buys a fresh
 * pre-validation bucket, because that private allowance never buys more than
 * the shared and per-source checks still gate. One source can spend
 * only a small fraction of that allowance (its own bucket, keyed on the
 * address the Cloudflare edge overwrites), so a single caller cannot pin the
 * shared bucket and deny every not-yet-validated credential its first
 * admission. `validated(credential)` moves a real credential onto its own
 * budget and gives back the shared slot it took (once — the shared pool's
 * refill heals any concurrent-charge overlap within one refill quantum) and
 * every source slot its admitted pre-validation requests took, per source, so
 * real traffic does not drain either allowance every new credential shares;
 * the charged-credential bookkeeping that makes each refund one-time is
 * capped, so neither it nor the bucket map grows with the flood. A request
 * without a credential is not counted: the pipeline refuses it with 401 before it calls
 * the API. The cost this accepts: a credential's first request spends a shared
 * slot, refunded when the API validates it, so a flood large enough to spend
 * the whole shared allowance can refuse a real credential still waiting on
 * that first validation until the window refills. That is the trade for a
 * bounded, unauthenticated allowance.
 *
 * The `RateLimit-*` headers advertise the allowance that governs the caller
 * (KRTX-4608): an unvalidated credential reads its own pre-validation
 * allowance — small enough to watch drain and exhaust at an honest pace — and
 * a validated one its own budget. The shared pool refills faster than any
 * honest client spends, so advertising it froze the advertised counter at
 * limit-1 and hid the enforcement; the per-source share is admission capacity
 * behind the shared edge, not a boundary one caller governs.
 *
 * Each gateway task counts alone, so the fleet allows limit × tasks. This
 * stops a runaway loop or a flood on one credential. It is not a quota.
 *
 * Returns the 429 response, or null when the request may continue.
 */
export function createTokenRateLimit(
  limitPerMinute: number,
  unvalidatedPerMinute = limitPerMinute,
  options: { trustEdgeClientIp?: boolean } = {},
): TokenRateLimit {
  const limiter = new TokenBucketRateLimiter('gateway_token');
  // Per-source buckets live in their OWN limiter: source keys are caller-shaped
  // (one address per caller), so a flood of them in a shared map would evict
  // the shared bucket and every validated credential's bucket out from under
  // them — resetting the very allowances this limit promises (KRTX-4528).
  const sourceLimiter = new TokenBucketRateLimiter('gateway_source');
  // Pre-validation buckets live in their OWN limiter too (credential-shaped
  // keys, like source keys): a flood of fakes fills this map, never the map
  // that holds the shared bucket and every validated credential's budget
  // (KRTX-4528). An eviction here only resets one caller's own allowance to
  // full, never anyone else's.
  const preValidationLimiter = new TokenBucketRateLimiter('gateway_prevalidation');
  // The credentials the API has answered with a principal. Only a real
  // credential gets in, so the set is bounded by the credential store, never by
  // what a caller sends.
  const validatedKeys = new Set<string>();
  // Credentials charged to the shared bucket while unvalidated; their slot is
  // refunded once, when the API validates them. The shared allowance bounds
  // how fast keys arrive, not how many accumulate — entries leave only through
  // `validated()`, which needs the API to answer a principal — so the oldest
  // key is dropped at the cap, as the bucket map drops its own oldest
  // (MAX_BUCKETS in packages/shared/src/rate-limit.ts). A credential whose
  // entry was evicted forfeits only its one-slot refund.
  const chargedShared = new Set<string>();
  // Credentials charged to source slots while unvalidated: credential hash →
  // source key → how many of that source's slots the credential's admitted
  // pre-validation requests took. Every charge refunds once, at validation
  // (KRTX-4608 review: a booting credential's ten concurrent first contacts
  // charged ten slots and one entry per credential refunded one, leaking the
  // rest into the share legitimate traffic needs). Bounded like chargedShared:
  // the oldest credential is evicted at MAX_CHARGED_SHARED, a credential keeps
  // at most MAX_SOURCE_KEYS_PER_CREDENTIAL distinct sources, and each source
  // counts at most one window's worth of refunds (sourcePolicy.limit) — what
  // falls out of a bound forfeits its refund, as a shared-set eviction does.
  const chargedSource = new Map<string, Map<string, number>>();
  const policy = { limit: limitPerMinute, windowMs: 60_000 };
  const sharedPolicy = { limit: Math.max(1, unvalidatedPerMinute), windowMs: 60_000 };
  // One credential's own pre-validation allowance (KRTX-4608): 20/min — a
  // token every 3s, small enough that a client watches its own counter drain
  // and exhaust at an honest pace — capped at the budget the credential
  // graduates to at validation, so an unvalidated caller is never promised
  // more than it will have once the API vouches for it. It bounds only the
  // caller whose key holds it.
  const preValidationPolicy = {
    limit: Math.min(UNVALIDATED_CREDENTIAL_LIMIT, Math.max(1, limitPerMinute)),
    windowMs: 60_000,
  };
  // One source may spend only a small fraction of the shared allowance: a
  // request refused here never reaches the API, so a credential it refuses can
  // never validate and stays refused while a flood runs — one shared bucket
  // with no per-source bound is pinnable by a single caller. Per-source keys
  // live in their own limiter, whose bucket count is capped; the source is
  // charged only when the operator's edge vouches for it (`trustEdgeClientIp`,
  // default on: the shipped Kortix edge is a Cloudflare-locked ALB — see
  // server.ts — where the address is edge-set). A deployment without such an
  // edge sets it off: an untrusted header would let one caller rotate
  // addresses and buy a fresh source allowance each time.
  //
  // No cap on this share (KRTX-4608 review): behind the shipped edge the
  // source is the ALB socket peer — many unrelated callers share it — so the
  // share is admission capacity, sized to admit a boot burst of legitimate
  // first contacts together (the counter-inert probe's eleven). The counter a
  // caller watches drain is its own pre-validation allowance above, not this
  // share.
  const sourcePolicy = {
    limit: Math.max(1, Math.floor(unvalidatedPerMinute / 100)),
    windowMs: 60_000,
  };
  const limit = (
    request: Request,
    headers = new Headers(),
    source?: string | null,
  ): Response | null => {
    const credential = credentialOf(request);
    if (!credential) return null;
    const key = hashOf(credential);
    const validated = validatedKeys.has(key);
    // The caller's own pre-validation allowance, checked first: a credential
    // its own bucket refuses stops here, before the source is read — its
    // refusals never spend the source's shared slots (KRTX-4608 review: a
    // hammering credential must not consume the capacity other callers share).
    const preValidation = !validated
      ? preValidationLimiter.check(key, preValidationPolicy)
      : null;
    // A validated credential keeps its own budget; anything else shares one
    // bucket, so a rotating fake bearer spends the shared allowance, never its
    // own private one — after its own pre-validation allowance and its
    // source's small share.
    const sourceKey =
      !validated && source && (options.trustEdgeClientIp ?? true) ? source : null;
    const fromSource =
      preValidation && !preValidation.allowed
        ? null
        : sourceKey
          ? sourceLimiter.check(sourceKey, sourcePolicy)
          : null;
    const result =
      preValidation && !preValidation.allowed
        ? preValidation
        : fromSource && !fromSource.allowed
          ? fromSource
          : limiter.check(validated ? key : UNVALIDATED, validated ? policy : sharedPolicy);
    if (!validated && result.allowed) {
      if (chargedShared.size >= MAX_CHARGED_SHARED) {
        const oldest = chargedShared.values().next().value;
        if (oldest !== undefined) chargedShared.delete(oldest);
      }
      chargedShared.add(key);
      if (sourceKey) {
        let bySource = chargedSource.get(key);
        if (!bySource) {
          if (chargedSource.size >= MAX_CHARGED_SHARED) {
            const oldest = chargedSource.keys().next().value;
            if (oldest !== undefined) chargedSource.delete(oldest);
          }
          bySource = new Map();
          chargedSource.set(key, bySource);
        }
        if (bySource.size >= MAX_SOURCE_KEYS_PER_CREDENTIAL && !bySource.has(sourceKey)) {
          const oldest = bySource.keys().next().value;
          if (oldest !== undefined) bySource.delete(oldest);
        }
        bySource.set(sourceKey, Math.min((bySource.get(sourceKey) ?? 0) + 1, sourcePolicy.limit));
      }
    }
    // Advertise the allowance that governs this caller (KRTX-4608): for an
    // unvalidated credential that is its own pre-validation allowance, whose
    // counter a client can watch move and exhaust. The shared pool refills
    // faster than any honest client spends; advertising it froze the advertised
    // count at limit-1 and hid the enforcement. A refusal advertises the
    // result that refused it.
    const advertised = result.allowed && preValidation ? preValidation : result;
    headers.set('RateLimit-Limit', String(advertised.limit));
    headers.set('RateLimit-Remaining', String(advertised.remaining));
    headers.set('RateLimit-Reset', String(Math.ceil(advertised.resetMs / 1000)));
    if (result.allowed) return null;
    // A refusal must also stop the upload: an unread body is still buffered.
    request.body?.cancel().catch(() => {});
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
    );
    const response = rateLimitedResponse(new URL(request.url).pathname, retryAfterSeconds);
    headers.forEach((value, name) => response.headers.set(name, value));
    return response;
  };
  limit.validated = (credential: string) => {
    const key = hashOf(credential);
    validatedKeys.add(key);
    // Give back the shared slot this credential's pre-validation request took,
    // once: it now has its own budget to be counted against.
    if (chargedShared.delete(key)) limiter.refund(UNVALIDATED, sharedPolicy);
    // Its source slots too (KRTX-4608): the share bounds never-validated push,
    // and the API has vouched for this credential — every slot its admitted
    // pre-validation requests took comes back, per source.
    const bySource = chargedSource.get(key);
    if (bySource) {
      chargedSource.delete(key);
      for (const [sourceKey, charges] of bySource)
        for (let i = 0; i < charges; i++) sourceLimiter.refund(sourceKey, sourcePolicy);
    }
  };
  limit.buckets = () => limiter.keys();
  limit.chargedCount = () => chargedShared.size;
  return limit;
}

/** The bucket every credential this task has not validated shares. */
const UNVALIDATED = 'distinct_credentials';

/** The cap on the charged-shared set, as MAX_BUCKETS caps the bucket map. */
const MAX_CHARGED_SHARED = 50_000;

/** The pre-validation allowance one credential spends alone (KRTX-4608),
 *  capped at the credential's own validated budget.
 *
 *  20/min (KRTX-4608 review round 3): a cold credential's concurrent
 *  first-use burst — the review's eleven simultaneous requests, all still
 *  waiting on their validation callbacks — must admit in full, so the
 *  allowance is twice that burst. It still drains visibly at any pace under
 *  20 sends and exhausts into a 429 at send 21: a bounded probe's reach, and
 *  a 30th of the 600/min budget the credential graduates to once the API
 *  vouches for it. A made-up bearer's push is bounded by this allowance; a
 *  flood of rotating bearers by the per-source share and the shared pool. */
const UNVALIDATED_CREDENTIAL_LIMIT = 20;

/** The distinct sources one credential may hold charge bookkeeping for. */
const MAX_SOURCE_KEYS_PER_CREDENTIAL = 8;

/**
 * The credential the pipeline will extract — the same grammar as `bearer()` in
 * `create-gateway.ts` (`/^Bearer\s+(\S.*)$/i`, trimmed) — or the `x-api-key`
 * that Anthropic SDKs send instead. Counting exactly the headers the pipeline
 * acts on leaves no header that reaches the API uncounted: a whitespace-bearing
 * bearer used to fall through here and flood the API under the limiter's feet.
 */
function credentialOf(request: Request): string | null {
  const bearer = /^Bearer\s+(\S.*)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  return bearer?.trim() || request.headers.get('x-api-key')?.trim() || null;
}

// Keyed per process: the bucket key never leaves memory, and a HMAC cannot be
// correlated against an externally computed digest of a stolen key anyway.
const BUCKET_KEY_SALT = randomBytes(32).toString('hex');

function hashOf(credential: string): string {
  return createHmac('sha256', BUCKET_KEY_SALT).update(credential).digest('hex');
}

const MESSAGE = 'Too many requests for this credential. Retry shortly.';

/** A 429 in the envelope of the route's protocol: Anthropic for Messages and Claude Code, OpenAI otherwise. */
function rateLimitedResponse(path: string, retryAfterSeconds: number): Response {
  if (path.endsWith('/messages') || path.includes('/claude-code/')) {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
      },
    );
  }
  return gatewayErrorResponse(429, {
    message: MESSAGE,
    code: 'rate_limited',
    provider: '',
    requestedModel: '',
    resolvedModel: '',
    requestId: '',
    suggestion: 'Slow down. The limit is per credential per minute.',
    retryAfterSeconds,
  });
}
