import { TimeoutError, withRetry } from '@kortix/llm-gateway';
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  /**
   * The API inside the VPC (KORTIX_API_INTERNAL_URL), tried before `baseUrl`.
   * A call it does not answer marks it down for a minute; `baseUrl` serves.
   */
  internalBaseUrl?: string;
  token: string;
  /** Proof for `/internal/*` at the public API edge (KORTIX_INTERNAL_EDGE_KEY). */
  edgeKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** One /admit attempt: it runs four steps, so it gets more than `timeoutMs`. */
  admitTimeoutMs?: number;
}

export class ApiUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
  ) {
    super(`kortix api ${path} unavailable${status ? ` (${status})` : ''}`);
    this.name = 'ApiUnavailableError';
  }
}

export interface ApiPingResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

/** How long a private URL that did not answer is skipped for the public one. */
const INTERNAL_DOWN_MS = 60_000;

/** The ping's private attempt: a VPC hop that has not answered /health in 1 s is down. */
const PRIVATE_PING_MS = 1_000;

/** Cap slow-timeout retries so a congested DB pool does not multiply in-flight queries 3x. */
const MAX_SLOW_TIMEOUT_ATTEMPTS = 2;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createControlPlaneTransport(opts: ApiClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const internalBaseUrl = opts.internalBaseUrl?.replace(/\/+$/, '') || undefined;
  const rawFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  // ponytail: one per-process switch; a broken private path costs one failed attempt per minute.
  let internalDownUntil = 0;
  const privateUp = () => !!internalBaseUrl && Date.now() >= internalDownUntil;
  // A thrown fetch (refused, reset, DNS, timeout) on the private URL sends the
  // next minute of calls to the public one. A response, even a 5xx, is the
  // API answering, so it keeps the private URL.
  const fetchImpl = async (path: string, init: RequestInit): Promise<Response> => {
    if (!internalBaseUrl || !privateUp()) return rawFetch(`${baseUrl}${path}`, init);
    try {
      return await rawFetch(`${internalBaseUrl}${path}`, init);
    } catch (err) {
      internalDownUntil = Date.now() + INTERNAL_DOWN_MS;
      throw err;
    }
  };
  const timeoutMs = opts.timeoutMs ?? positiveIntEnv('GATEWAY_API_TIMEOUT_MS', 12_000);
  const admitTimeoutMs = opts.admitTimeoutMs ?? positiveIntEnv('GATEWAY_ADMIT_TIMEOUT_MS', 15_000);

  /**
   * One control-plane call, with bounded retries.
   *
   * `retryOnTimeout` says whether a SLOW attempt (one that produced no response
   * inside `timeoutMs`) may be repeated. It is a per-call decision because the
   * two kinds of call differ in what a repeat costs:
   *
   * - Admission and resolution calls are what the caller is waiting on. A
   *   repeat that succeeds turns a hard error into a served request. The
   *   admission hold is the one nuance: `/authorize` may already have taken a
   *   1-cent atomic hold the timed-out attempt never learned about, and that
   *   hold is orphaned — but it is orphaned by the timeout itself, not by the
   *   retry, and NOT retrying leaves the same orphan plus a failed request. Only
   *   a full control-plane outage (every attempt times out) can orphan more than
   *   one, and nothing is being served then anyway.
   * - `recordUsage` / `recordTrace` are settlement WRITES with nobody waiting.
   *   A timed-out attempt that the API actually committed would be charged
   *   twice by a repeat, so they keep the narrow policy: retry a refused or
   *   5xx-answered attempt, never a silent one.
   * - `/admit` is never repeated (`once`): see `admit` below.
   */
  const post = async <T>(
    path: string,
    payload: unknown,
    { retryOnTimeout = false, once = false }: { retryOnTimeout?: boolean; once?: boolean } = {},
  ): Promise<T> => {
    let timeoutAttempts = 0;
    return withRetry(
      async (signal) => {
        let response: Response;
        try {
          response = await fetchImpl(path, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${opts.token}`,
              // Edge proof for /internal/* on the public API host (api-router worker).
              ...(opts.edgeKey ? { 'x-kortix-internal-edge-key': opts.edgeKey } : {}),
            },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          throw new ApiUnavailableError(path);
        }
        if (!response.ok) {
          throw new ApiUnavailableError(path, response.status);
        }
        return (await response.json()) as T;
      },
      {
        maxAttempts: once ? 1 : 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        timeoutMs: once ? admitTimeoutMs : timeoutMs,
        // `timeoutMs` is a PER-ATTEMPT budget, and withRetry settles an attempt
        // that overruns it with a `TimeoutError` — not with whatever `fn` would
        // eventually have thrown once the abort landed. Accepting only
        // `ApiUnavailableError` here therefore made `maxAttempts: 3` dead code
        // for the single failure mode these retries exist for: a SLOW control
        // plane. The un-retried `TimeoutError` escaped `authorize()` in
        // simple-handler.ts and reached the client as an opaque
        // `503 gateway_error "Gateway unavailable"`.
        //
        // Measured on staging 2026-09-16: 2 of 30 identical
        // `POST /v1/llm/chat/completions` calls answered that 503 at 5.14 s and
        // 5.15 s (exactly this 5 s budget); the other 28 answered
        // `400 provider_disabled` in 2.0-3.2 s. That is the GW-ACCESS-1
        // release-gate flake (runs 35012251397, 35036053187).
        //
        // Worst case stays bounded by `maxAttempts`: 3 x 5 s plus ~0.3 s of
        // backoff before the caller is told the API is unreachable.
        isRetryable: (err) => {
          if (err instanceof ApiUnavailableError) return true;
          if (retryOnTimeout && err instanceof TimeoutError) {
            timeoutAttempts += 1;
            return timeoutAttempts < MAX_SLOW_TIMEOUT_ATTEMPTS;
          }
          return false;
        },
      },
    );
  };

  return { post,
    // The ping owns both attempts, each on its own signal: a private path that
    // hangs costs PRIVATE_PING_MS, trips the switch, and the public URL answers.
    ping: async () => {
      const started = Date.now();
      const health = (base: string, ms: number) =>
        rawFetch(`${base}/health`, { method: 'GET', signal: AbortSignal.timeout(ms) });
      try {
        let res: Response | undefined;
        if (internalBaseUrl && privateUp()) {
          try {
            res = await health(internalBaseUrl, PRIVATE_PING_MS);
          } catch {
            internalDownUntil = Date.now() + INTERNAL_DOWN_MS;
          }
        }
        res ??= await health(baseUrl, 3_000);
        return { ok: res.ok, latencyMs: Date.now() - started, status: res.status };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
