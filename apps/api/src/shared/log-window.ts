/**
 * Rate-limit a repeated log line by key: the first line in a window logs
 * immediately, later lines increment a best-effort `suppressed` count that the
 * next emitted line reports in its context. Throttle the LINE only, never the
 * behavior it describes, and keep the line text grouping verbatim — the count
 * rides the structured context. A ten-minute window permits six lines per key
 * per process per hour; the severity escalation of those lines is capped at
 * one `warn` per key per hour (logWindowWarnDecision, KRTX-4674: an hour of
 * grinding past the burst band made every window's line ship at warn —
 * 16/15/15 per route across three replicas — and re-tripped the infra-sweep's
 * 10/h new-warn-pattern bar). Suppression counts are best-effort: they appear
 * only on the next emitted line. A final quiet burst, eviction or process
 * restart can lose pending counts; use a precise per-request source for exact
 * accounting.
 *
 * Users: the marked refusals of the global error handler
 * (shared/dead-credential-log.ts, KRTX-1039/4442/4454), the severity
 * escalations of the sandbox-proxy forward refusals
 * (sandbox-proxy/forward/access.ts, retry.ts) and the drives Platinum
 * failure lines (drives/volumes.ts, KRTX-4672).
 */

const WINDOW_MS = 10 * 60_000;
const WARN_WINDOW_MS = 60 * 60_000;
const MAX_TRACKED_MESSAGES = 10_000;
/** Warn lines per key per process per hour (the escalation cap). */
const MAX_WARNS_PER_HOUR = 1;

type Window = { loggedAt: number; suppressed: number };
// replica-local: a log-noise limiter; each replica rate-limits its own lines.
const windows = new Map<string, Window>();

type WarnHour = { hourStart: number; warns: number };
// replica-local: a log-noise limiter; each replica rate-limits its own lines.
const warnHours = new Map<string, WarnHour>();

/** First warning logs immediately; the next window reports pending suppression. */
export function logWindowDecision(key: string, now: number): { log: boolean; suppressed: number } {
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

/**
 * Decide and consume one warn slot for a key: true when the key may ship the
 * line it is about to log at `warn`, and the consumption IS the slot. The
 * escalation sites ask only when a line is about to log with the burst band
 * crossed, so a decided slot is always a shipped warn line. Without the cap
 * the escalation fired at every ten-minute window (six warns per hour per
 * replica, sixteen across the fleet in one heavy hour — KRTX-4674's residual),
 * above the infra-sweep's 10/h new-warn-pattern bar.
 */
export function logWindowWarnDecision(key: string, now: number): boolean {
  const hour = warnHours.get(key);
  if (hour && now - hour.hourStart < WARN_WINDOW_MS) {
    if (hour.warns >= MAX_WARNS_PER_HOUR) return false;
    hour.warns += 1;
    return true;
  }
  if (!hour && warnHours.size >= MAX_TRACKED_MESSAGES) {
    const oldest = warnHours.keys().next().value;
    if (oldest !== undefined) warnHours.delete(oldest);
  }
  warnHours.set(key, { hourStart: now, warns: 1 });
  return true;
}

/** Test seam. */
export function resetLogWindowsForTests(): void {
  windows.clear();
  warnHours.clear();
}
