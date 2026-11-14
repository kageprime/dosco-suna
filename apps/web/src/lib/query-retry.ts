/**
 * Retry policy of the web app's QueryClient.
 *
 * A 4xx is final, except 429: the API refused the request before it ran, and
 * the same request succeeds once the rate limit has room again. Before this,
 * one 429 on a permission probe left a settings page on "Could not check your
 * access" until the person clicked Try again (dev, 2026-11-14). A 429 now
 * waits and tries again, so the page stays in its loading state and then loads.
 */

/** At most this many tries after a 429. */
const RATE_LIMIT_RETRIES = 3;
/** A 5xx or a network failure: at most this many tries. */
const TRANSIENT_RETRIES = 3;
/** The first wait after a 429; it doubles on each try (2 s, 4 s, 8 s). */
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
/** The longest wait for one retry. */
const MAX_RATE_LIMIT_DELAY_MS = 60_000;

interface RetryableError {
  status?: number;
  response?: { headers?: { get?: (name: string) => string | null } };
}

function statusOf(error: unknown): number | undefined {
  const status = (error as RetryableError | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** The server's `Retry-After` for a 429, in ms; null without one. */
export function retryAfterMs(error: unknown): number | null {
  const raw = (error as RetryableError | null)?.response?.headers?.get?.('retry-after');
  if (raw == null || raw.trim() === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** `retry` for queries: never a 4xx other than 429. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429) return failureCount < RATE_LIMIT_RETRIES;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < TRANSIENT_RETRIES;
}

/**
 * `retryDelay` for queries. The API's limiter is a token bucket (300/min, one
 * token every 200 ms) and answers `Retry-After: 1`: after a burst, every
 * refused query waiting that 1 s would collide again. So a 429 waits the
 * longer of `Retry-After` and a doubling backoff (2 s, 4 s, 8 s), plus up to
 * half of that again at random, so the refused queries come back spread out.
 * Anything else keeps TanStack's default backoff (1 s, 2 s, 4 s, max 30 s).
 */
export function queryRetryDelay(failureCount: number, error: unknown, random: () => number = Math.random): number {
  if (statusOf(error) === 429) {
    const base = Math.max(retryAfterMs(error) ?? 0, RATE_LIMIT_BASE_DELAY_MS * 2 ** failureCount);
    return Math.min(Math.floor(base * (1 + random() / 2)), MAX_RATE_LIMIT_DELAY_MS);
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}
