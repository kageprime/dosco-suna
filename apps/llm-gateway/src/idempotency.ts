import { createHash } from 'node:crypto';

/**
 * Client `Idempotency-Key` replay for the inference edge (KRTX-4612).
 *
 * A client retrying an inference request — a network reset after the provider
 * answered, a double-fired submit — used to execute the provider again and
 * settle a second usage record: every HTTP request minted a fresh request id,
 * so metering had no memory of the first attempt. With a key, the edge now
 * materializes the first 2xx answer and serves it to every same-key retry:
 * one execution, one usage record, and the client sees one completion id.
 *
 * The key is scoped to the credential AND the exact body. A key reused with a
 * different body is a different operation: OpenAI and Stripe reject that case,
 * and replaying the first body's answer here would serve a wrong result —
 * executing fresh is the safer relaxation.
 *
 * Errors are never replayed: a retry after a 4xx/5xx must re-execute, and an
 * error settles no tokens (so it cannot double-meter). A caller that shares
 * another's failed execution gets the 503 envelope; the entry is forgotten,
 * so its own next retry executes fresh.
 *
 * A replay is still a request: every hit re-runs the host's credential +
 * budget check (`reauthorize`) before the cached answer is served, so a
 * revoked credential, a suspension or an over-budget account is never served
 * from the cache (CWE-863; KRTX-4612 review). Billing-active is not
 * re-checked on a hit: the cached answer was already settled, and the
 * credential + budget gates cover the revocation cases that matter here.
 *
 * The gateway runs several replicas behind a load balancer, so a retry usually
 * lands on a replica that never saw the first attempt (KRTX-4612 reoccurred on
 * prod for exactly that reason). With a `shared` store the first 2xx answer is
 * also written to the control plane for the TTL and every replica consults it
 * on a local miss. Entries there are keyed by the same credential-scoped hash,
 * so only the holder of the credential can read one back.
 *
 * ponytail: two same-key requests that are in flight at the SAME instant on
 * two replicas both execute (the shared store holds finished answers only, no
 * claim). A retry after the first answer or failure is the case that matters.
 */

/** A replayable answer: everything needed to rebuild the Response per caller. */
export interface ReplayedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** Set by the shared store: the answer's original absolute expiry (epoch ms). A shared hit never outlives it. */
  expiresAt?: number;
}

/** The fields of an inference request the replay reads; the edge passes its full request. */
export interface ReplayRequest {
  authorization: string | undefined;
  rawBody: string;
}

export interface ReplayOptions {
  /**
   * Re-validate the credential before serving a cached answer: a replay is
   * still a request, so revocation, suspension and budget must apply to it
   * too (CWE-863; KRTX-4612 review). The host wires this to the same
   * credential + budget composition a fresh request's admission runs.
   * `false` drops the entry and the request executes through the pipeline,
   * which serves the proper 401/402. A throw means the control plane could
   * not answer: the entry stays, the pipeline answers (503 when its own
   * admission fails the same way).
   */
  reauthorize?: (request: ReplayRequest) => Promise<boolean>;
  /** Answers finished on any replica. A store failure never fails the request. */
  shared?: SharedReplayStore;
}

/** Larger answers (an image) stay replica-local: they would bloat the shared row. */
export const MAX_SHARED_BYTES = 1024 * 1024;

/** The control plane's copy of finished answers, shared by every gateway replica. */
export interface SharedReplayStore {
  get: (key: string) => Promise<ReplayedResponse | null>;
  put: (key: string, answer: ReplayedResponse) => Promise<void>;
}

/** Longer than any realistic client retry window (OpenAI holds keys for 24 h). */
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

interface ReplayEntry {
  expiresAt: number;
  /** Byte length of the cached body, accounted once the execution resolves. */
  bytes: number;
  result: Promise<ReplayedResponse>;
}

/** A Response body is single-use; the cached answer is not. Rebuild one per caller. */
function replayedResponse(answer: ReplayedResponse): Response {
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  });
}

export function createIdempotencyReplay(now: () => number = Date.now, options: ReplayOptions = {}) {
  const entries = new Map<string, ReplayEntry>();
  let cachedBytes = 0;

  const forget = (key: string, entry?: ReplayEntry): void => {
    const held = entries.get(key);
    // Only forget the entry the caller means: a slot may have been replaced
    // (expired and re-executed) between the call and the forget.
    if (!held || (entry !== undefined && held !== entry)) return;
    cachedBytes -= held.bytes;
    entries.delete(key);
  };

  // Map iteration is insertion order: the first key is the oldest entry.
  const evict = (): void => {
    while (entries.size > MAX_ENTRIES || cachedBytes > MAX_CACHED_BYTES) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      forget(oldest.value);
    }
  };

  return async <Req extends ReplayRequest>(
    protocol: string,
    idempotencyKey: string | undefined,
    request: Req,
    call: (request: Req) => Promise<Response>,
  ): Promise<Response> => {
    if (!idempotencyKey) return call(request);
    // A streaming request has no replayable answer: its retry re-executes.
    let streaming = false;
    try {
      streaming = (JSON.parse(request.rawBody) as { stream?: unknown } | null)?.stream === true;
    } catch {
      // The pipeline answers invalid JSON with a 400; nothing to replay either way.
    }
    if (streaming) return call(request);

    // Scoped to the wire operation too: one cache serves every inference
    // endpoint, and the same key + body bytes on a second endpoint must not
    // replay the first endpoint's answer shape. The image operations get one
    // tag each (images:generations / images:edits): a body with prompt +
    // images[] is valid on both — generations ignores images[] — so the
    // bytes alone do not separate them.
    const key = createHash('sha256')
      .update(`${protocol}\u0000${request.authorization ?? ''}\u0000${idempotencyKey}\u0000`)
      .update(request.rawBody)
      .digest('hex');
    // A replay is still a request: a revoked credential, a suspension or an
    // exhausted budget must not be served from any cache.
    const admitted = async (): Promise<boolean | 'undecided'> =>
      options.reauthorize ? options.reauthorize(request).catch(() => 'undecided' as const) : true;
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) {
      const verdict = await admitted();
      if (verdict === true) return replayedResponse(await hit.result);
      if (verdict === 'undecided') {
        // The control plane could not answer the check: run the pipeline for
        // its own admission verdict and keep the entry — a transient outage
        // must not destroy a valid cache (or serve one, unchecked).
        return call(request);
      }
      forget(key); // the credential behind this entry is no longer admitted
    }
    forget(key);

    const result = (async (): Promise<ReplayedResponse> => {
      // Another replica may have answered this key already. Looked up inside
      // the entry's own execution, so concurrent callers still share one.
      const shared = options.shared ? await options.shared.get(key).catch(() => null) : null;
      if (shared && (await admitted()) === true) return shared;
      const res = await call(request);
      const answer = {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers],
        body: await res.text(),
      };
      // Written before the client sees the answer: its retry may reach another replica at once.
      if (options.shared && answer.status >= 200 && answer.status < 300 && Buffer.byteLength(answer.body) <= MAX_SHARED_BYTES) {
        await options.shared.put(key, answer).catch(() => {});
      }
      return answer;
    })();
    const entry: ReplayEntry = { expiresAt: now() + TTL_MS, bytes: 0, result };
    entries.set(key, entry);
    result.then(
      (answer) => {
        if (entries.get(key) !== entry) return;
        if (answer.expiresAt !== undefined) entry.expiresAt = Math.min(entry.expiresAt, answer.expiresAt);
        const isOk = answer.status >= 200 && answer.status < 300;
        if (!isOk) {
          forget(key, entry); // an error stays retryable
          return;
        }
        entry.bytes = Buffer.byteLength(answer.body);
        cachedBytes += entry.bytes;
        evict();
      },
      () => forget(key, entry), // a failed execution is retryable
    );
    return replayedResponse(await result);
  };
}
