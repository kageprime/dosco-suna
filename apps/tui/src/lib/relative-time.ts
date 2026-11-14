/**
 * The TUI's relative-time ladders: the sidebar's right-hand age column
 * (`relativeAge`), the turn header's short age (`relativeShort`) and the
 * countdown to a future instant (`relativeUntil`).
 *
 * The age ladder is fixed-width by construction (at most 4 columns: `now`,
 * `59m`, `23h`, `29d`, `11mo`, `9y`) so a row never reflows when a session's
 * age ticks over. It mirrors `shortRelative` in
 * `packages/ui/src/session/actions/project-session-list-helpers.ts`
 * so a session reads the same in both clients.
 *
 * Pure: `now` is a parameter, never `Date.now()`.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The month/year steps are display buckets, not calendar arithmetic. */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * `fromMs` rendered as an age against `nowMs`.
 *
 * A future or unparseable timestamp reads `now` rather than a negative age:
 * clock skew between the API and this terminal is real, and `-3m` is worse
 * than a rounding error.
 */
export function relativeAge(fromMs: number, nowMs: number): string {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return '';
  const delta = nowMs - fromMs;
  if (delta < MINUTE_MS) return 'now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h`;
  if (delta < MONTH_MS) return `${Math.floor(delta / DAY_MS)}d`;
  if (delta < YEAR_MS) return `${Math.floor(delta / MONTH_MS)}mo`;
  return `${Math.floor(delta / YEAR_MS)}y`;
}

/**
 * `now`, `12s`, `4m`, `3h`, `2d` — the age a turn header prints. Seconds
 * granularity under a minute (`relativeAge` collapses it to `now`) and days
 * past 24 hours; there is no month step.
 */
export function relativeShort(elapsedMs: number): string {
  const seconds = Math.max(Math.floor(elapsedMs / 1000), 0);
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `in 5m` for a future instant, `due` for a past one, `—` for none. */
export function relativeUntil(targetMs: number, nowMs: number): string {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return '—';
  const delta = targetMs - nowMs;
  if (delta <= 0) return 'due';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
