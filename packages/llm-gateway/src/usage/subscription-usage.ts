/**
 * Plan usage of a subscription account (a ChatGPT or Claude login), read from
 * the provider's response headers. Every response of both providers names how
 * much of each plan window is used:
 *
 *   - ChatGPT: `x-codex-{primary,secondary}-used-percent` (0–100),
 *     `-window-minutes`, `-reset-at` (epoch seconds) or `-reset-after-seconds`.
 *   - Claude: `anthropic-ratelimit-unified-{5h,7d,…}-utilization` (0–1),
 *     `-reset` (epoch seconds), and `anthropic-ratelimit-unified-status`
 *     (`rejected` while the account is limited).
 *
 * The gateway reports the snapshot to the host, which stores it on the account
 * so the account list can show it. Nothing here reads a body or a token.
 */

export interface SubscriptionUsageWindow {
  /** `five_hour`, `weekly`, or the provider's own window name (`7d_opus`). */
  id: string;
  /** The window length in minutes: 300 for five hours, 10080 for a week. Null when unknown. */
  window_minutes: number | null;
  /** The share of the window's allowance used, 0–100. */
  used_percent: number;
  /** When the window resets, ISO 8601. Null when the provider did not say. */
  resets_at: string | null;
}

export interface SubscriptionUsage {
  windows: SubscriptionUsageWindow[];
  /** The provider refuses this account's requests now. */
  limited: boolean;
  observed_at: string;
  /** `response`: a model call's headers. `usage_endpoint`: the provider's usage API. */
  source: 'response' | 'usage_endpoint';
}

const FIVE_HOURS = 300;
const WEEK = 7 * 24 * 60;

function finite(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function percent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** The window's name from its length: the two windows both providers use get stable ids. */
export function windowId(minutes: number | null, fallback: string): string {
  if (minutes === FIVE_HOURS) return 'five_hour';
  if (minutes === WEEK) return 'weekly';
  return fallback;
}

/**
 * The instant `Date` can represent, else null. The provider's header is untrusted
 * input: a reset past year 275760 is no reset time, never a throw out of a read
 * that runs after the answer was already served.
 */
export function representable(milliseconds: number): Date | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function epochIso(seconds: number | null): string | null {
  return seconds !== null && seconds > 0 ? representable(seconds * 1000)?.toISOString() ?? null : null;
}

function afterIso(seconds: number | null, now: number): string | null {
  return seconds !== null ? representable(now + seconds * 1000)?.toISOString() ?? null : null;
}

/**
 * The reset time a provider's usage body names — epoch seconds, an ISO
 * string, or seconds from `now` — or null when it names none that `Date` can
 * represent. The provider's body is untrusted input: a reset past year 275760
 * is no reset time, never a throw out of a read that runs after the answer was
 * already served. `Date.parse` agrees on the string form (`NaN` for an
 * unrepresentable one).
 */
export function resetIso(value: unknown, now: number, afterSeconds?: unknown): string | null {
  const at = (milliseconds: number) => representable(milliseconds)?.toISOString() ?? null;
  if (typeof value === 'number' && value > 0) return at(value * 1000);
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return at(Date.parse(value));
  if (typeof afterSeconds === 'number' && afterSeconds >= 0) return at(now + afterSeconds * 1000);
  return null;
}

function codexWindows(headers: Headers, now: number): UsageWindowInput[] {
  const windows: UsageWindowInput[] = [];
  for (const slot of ['primary', 'secondary']) {
    const used = finite(headers.get(`x-codex-${slot}-used-percent`));
    if (used === null) continue;
    const minutes = finite(headers.get(`x-codex-${slot}-window-minutes`));
    const resetAt = finite(headers.get(`x-codex-${slot}-reset-at`));
    const resetAfter = finite(headers.get(`x-codex-${slot}-reset-after-seconds`));
    windows.push({
      fallback: slot,
      window_minutes: minutes,
      used_percent: used,
      resets_at: resetAt !== null ? epochIso(resetAt) : resetAfter !== null ? afterIso(resetAfter, now) : null,
    });
  }
  return windows;
}

const CLAUDE_WINDOW_MINUTES: Record<string, number> = { '5h': FIVE_HOURS, '7d': WEEK };
const CLAUDE_UTILIZATION = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/;

function claudeWindows(headers: Headers): UsageWindowInput[] {
  const windows: UsageWindowInput[] = [];
  headers.forEach((value, key) => {
    const name = CLAUDE_UTILIZATION.exec(key)?.[1];
    const used = name ? finite(value) : null;
    if (!name || used === null) return;
    const minutes = CLAUDE_WINDOW_MINUTES[name] ?? null;
    windows.push({
      fallback: name,
      window_minutes: minutes,
      used_percent: used * 100,
      resets_at: epochIso(finite(headers.get(`anthropic-ratelimit-unified-${name}-reset`))),
    });
  });
  return windows;
}

/**
 * One provider-named window of a plan-usage read, before the snapshot shapes
 * it: the stable id comes from the window's length, with `fallback` for a
 * length that is not one of the stable ones.
 */
export interface UsageWindowInput {
  fallback: string;
  used_percent: number;
  window_minutes: number | null;
  resets_at: string | null;
}

/**
 * Shortest window first: the order every shaped reader carries. The provider's
 * own order is not a contract, but a reader that shapes provider-native order
 * (the Codex response headers live below) keeps it instead of sorting.
 */
export function byWindowLength(a: { window_minutes: number | null }, b: { window_minutes: number | null }): number {
  return (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity);
}

/**
 * The one shaping every subscription-usage snapshot takes, whoever read it —
 * the gateway from a model response's headers, the API from the provider's
 * usage endpoint: percents rounded to a tenth, the limit state, the
 * observation time and the source. A snapshot a host stores and one it
 * reports are the same shape. The caller brings the windows in its own order.
 */
export function usageSnapshot(
  windows: UsageWindowInput[],
  options: { limited: boolean; now: number; source: SubscriptionUsage['source'] },
): SubscriptionUsage | null {
  if (!windows.length) return null;
  const shaped = windows.map(({ fallback, ...window }) => ({ id: windowId(window.window_minutes, fallback), ...window, used_percent: percent(window.used_percent) }));
  return {
    windows: shaped,
    limited: options.limited || shaped.some((window) => window.used_percent >= 100),
    observed_at: new Date(options.now).toISOString(),
    source: options.source,
  };
}

/** The plan usage a ChatGPT or Claude response reports, or null when it reports none. */
export function subscriptionUsageFromHeaders(headers: Headers, now = Date.now()): SubscriptionUsage | null {
  const codex = codexWindows(headers, now);
  // A Codex response names `primary` then `secondary`, and the header reader
  // keeps that order; Claude's headers come in no name order, so they are
  // shortest window first, as every endpoint reader shapes them.
  const windows = codex.length ? codex : claudeWindows(headers).sort(byWindowLength);
  if (!windows.length) return null;
  return usageSnapshot(windows, {
    limited: headers.get('anthropic-ratelimit-unified-status') === 'rejected',
    now,
    source: 'response',
  });
}

/** A snapshot equal to the last one sent is re-sent at most once a minute. */
const RESEND_MS = 60_000;

function changed(a: SubscriptionUsage, b: SubscriptionUsage): boolean {
  if (a.limited !== b.limited || a.windows.length !== b.windows.length) return true;
  return a.windows.some((window, index) => {
    const other = b.windows[index]!;
    return window.id !== other.id || Math.abs(window.used_percent - other.used_percent) >= 1;
  });
}

/**
 * A fire-and-forget reporter for one gateway replica: every model response
 * calls it, and it sends a snapshot only when a window moved by a whole
 * percent, the limit state changed, or a minute passed. A failed send is logged
 * and never reaches the model response.
 */
export function createUsageReporter<Context>(
  send: (context: Context, secretId: string, usage: SubscriptionUsage) => Promise<void>,
  options: { now?: () => number; logger?: Pick<Console, 'warn'> } = {},
): (context: Context, secretId: string, usage: SubscriptionUsage) => void {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  // replica-local: the last snapshot sent per account, only to skip repeats.
  const last = new Map<string, { at: number; usage: SubscriptionUsage }>();
  return (context, secretId, usage) => {
    const previous = last.get(secretId);
    const at = now();
    if (previous && at - previous.at < RESEND_MS && !changed(previous.usage, usage)) return;
    last.set(secretId, { at, usage });
    if (last.size > 10_000) last.delete(last.keys().next().value!);
    send(context, secretId, usage).catch((error) => {
      logger.warn('[gateway] could not record subscription usage', { secretId, error: error instanceof Error ? error.message : String(error) });
    });
  };
}
