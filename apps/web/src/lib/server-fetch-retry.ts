/**
 * One retry for a server-side `GET` or `HEAD` whose connection fails before
 * any response arrives.
 *
 * Vercel runs this app on Fluid compute, which suspends an idle instance.
 * While it sleeps, the peer can close a pooled keep-alive socket. The first
 * request after the instance resumes writes into that dead socket, and undici
 * rejects with `TypeError: fetch failed` (cause `UND_ERR_SOCKET` "other side
 * closed", 0 bytes read) or a TLS reset (`ECONNRESET`). A browser retries such
 * a request once on a new connection; Node's `fetch` does not.
 *
 * Measured on prod, 2026-11-13 16:47Z to 11-14 15:47Z: 167 `TypeError: fetch
 * failed` lines, all with 0 bytes read, about 7 an hour. Next.js prints them
 * from the background refresh of a stale cached fetch
 * (`pendingRevalidate.catch(console.error)` in `next/dist/server/lib/patch-fetch.js`),
 * and the page itself serves the stale copy.
 *
 * Only a request without a body is retried, and only once, so a write is
 * never sent twice. An aborted request is never retried.
 */

const RETRY_INSTALLED = Symbol.for('kortix.serverFetchRetry');

/** Connection failures that happen before the response, per undici and Node. */
const STALE_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ECONNRESET',
  'EPIPE',
]);

/** Whether `error` is fetch's connection failure with a retryable cause. */
export function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const code: unknown = Reflect.get(cause, 'code');
  return typeof code === 'string' && STALE_CONNECTION_CODES.has(code);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function hasBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.body != null) return true;
  return typeof Request !== 'undefined' && input instanceof Request && input.body !== null;
}

function aborted(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.signal?.aborted) return true;
  return typeof Request !== 'undefined' && input instanceof Request && input.signal.aborted;
}

/** `fetchImpl` with the one-retry rule above. */
export function withStaleConnectionRetry(fetchImpl: typeof fetch): typeof fetch {
  const retrying = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      const method = requestMethod(input, init);
      const idempotent = (method === 'GET' || method === 'HEAD') && !hasBody(input, init);
      if (!idempotent || aborted(input, init) || !isStaleConnectionError(error)) throw error;
      return fetchImpl(input, init);
    }
  };
  return retrying as typeof fetch;
}

/**
 * Wraps `globalThis.fetch` once per process. Call it from `register()` in
 * `instrumentation.ts`: that runs before Next.js wraps `fetch` for its data
 * cache, so Next's own requests, its background refreshes included, go through
 * the retry. If Next.js has wrapped `fetch` already, this does nothing:
 * wrapping on top would hide the wrapper Next.js checks for.
 */
export function installServerFetchRetry(): void {
  const current = globalThis.fetch as typeof fetch & { __nextPatched?: boolean };
  if (typeof current !== 'function' || current.__nextPatched) return;
  if (Reflect.get(globalThis, RETRY_INSTALLED)) return;
  globalThis.fetch = withStaleConnectionRetry(current);
  Reflect.set(globalThis, RETRY_INSTALLED, true);
}
