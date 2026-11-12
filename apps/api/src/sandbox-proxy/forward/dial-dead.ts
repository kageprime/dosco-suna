/**
 * The dial-dead mark: a box whose HTTP path PROVED dead stops being dialled by
 * every request after the mark confirms (KRTX-4459).
 *
 * The prod shape that forced this: a session box's daemon died on a running
 * box, every proxied fetch to it timed out at the proxy's 15 s connect timer,
 * and the client kept polling (`/kortix/runtime/pending` reads in ~7-request
 * bursts every ~2-3 min). Each poll walked the whole auto-wake ladder — 4
 * attempts × 15 s + delays ≈ the full 50 s budget — before the give-up 502, so
 * ~5% of a small hour's rows read 45-50 s and the route's p95 read 15-45 s
 * (its p50 stayed at ~90 ms).
 *
 * Two review findings shaped what may mark a port:
 *
 * • The proxy's connect timer bounds the connect AND header phase, so a
 *   healthy-but-slow handler (a busy box answering headers in >15 s) produces
 *   the same TimeoutError as a dead dial. Marking on the timer alone would
 *   poison the port (review finding on the first cut, 2026-11-11).
 * • The ingress is an HTTPS provider edge that accepts TCP whatever the box
 *   behind it is doing, so a TCP connect proves nothing about the box (review
 *   finding on the second cut, 2026-11-11). The candidate streak only ever
 *   forms on header timeouts — a connection refusal never enters it — so a
 *   TCP probe of exactly the cases the streak holds is always "reachable".
 *
 * So a streak of two timeouts is only a CANDIDATE, and the mark confirms when
 * a bounded HTTP probe through the ingress — the same ingress base and auth
 * headers a real attempt sends, but a LIVENESS path, never the request's own
 * route — also gets no answer. The HTTP response is the one observable the
 * edge passes through from the box: any response (any status — for an unknown
 * path usually the box's own 404) proves the box's HTTP layer answers
 * requests and clears the streak; nothing within the probe budget proves it
 * answers no request, which is the dead-box shape. The path must be
 * independent of the request's route because the connect timer bounds the
 * header phase: a probe of the hung route itself would hang with it and
 * confirm the mark against a box whose other routes are healthy — one slow
 * route would poison the whole port (review finding on the third cut,
 * 2026-11-12). The budget is longer than one attempt timer so a handler that
 * answers late is served by the probe even though the attempts timed out.
 *
 * The probe runs DETACHED from the request: the confirming request keeps
 * today's ladder and its give-up, the probe settles on its own budget, and the
 * NEXT request fast-fails. One probe per key at a time: a concurrent burst
 * awaiting confirmation shares the first caller's probe instead of dialling
 * the box N times.
 *
 * A probe's silence proves the death of exactly the EPISODE it was asked
 * about (its mark object, captured at start): a successful dial may clear the
 * episode while the probe flies, and a later single timeout may open a fresh
 * one — the stale probe's silence says nothing about that replacement, whose
 * single timeout must never confirm (review finding on the fifth cut,
 * 2026-11-12).
 *
 * After confirmation:
 *   • every request fast-fails (give-up 502, zero dials) — no wake either;
 *     liveness stays owned by the wake the failing attempt already fired,
 *     the relaunch flow and the reaper;
 *   • one request per probe window dials again, and that request's probe call
 *     REVALIDATES the mark on the liveness path: a dial timeout proves the
 *     request's route silent, never the box's HTTP layer, so the old
 *     confirmation may not ride on it — a box the relaunch revived is served
 *     again within one probe budget even when its polled route keeps hanging,
 *     the shape that used to suppress it forever (review finding on the
 *     fourth cut, 2026-11-12);
 *   • the re-probe dial timing out does NOT un-confirm by itself, and silence
 *     on the revalidation keeps the mark and the window: a still-dead box
 *     gains one detached probe per window and nothing else.
 *
 * Writes are exempt: a prompt delivery or upload keeps today's ladder and its
 * ambiguity guards. Connection-refused and fast edge 502/503 answers (a booting
 * box) never throw, so they never mark — the short-delay ladder for those is
 * untouched.
 */

/** Timeouts inside this window count toward the candidate streak; a timeout
 *  older than this starts a new streak (a box that dials fine for 5 min is not
 *  the box that timed out). */
export const DIAL_DEAD_STREAK_WINDOW_MS = 5 * 60 * 1000;

/** Consecutive connect timeouts that make a box a dial-dead candidate. One is
 *  the stale-ingress case the ladder already recovers from; two in a row ask
 *  for the HTTP probe. */
export const DIAL_DEAD_AFTER_TIMEOUTS = 2;

/** How long a confirmed mark holds before ONE request may dial again. Longer
 *  than a client poll burst (the observed dead-box cadence is a burst every
 *  ~2-3 min), far shorter than a tab's lifetime. */
export const DIAL_DEAD_PROBE_SPACING_MS = 2 * 60 * 1000;

/** The HTTP probe's budget: longer than one attempt timer
 *  (`PROXY_ATTEMPT_TIMEOUT_MS`, 15 s) so a handler that answers late is served
 *  by the probe; a path that answers nothing within it is dial-dead. */
export const DIAL_PROBE_TIMEOUT_MS = 30_000;

/** The path every dial-dead probe dials instead of the request's route. No
 *  real server routes it, so the answer (almost always a fast 404) is the
 *  box's own HTTP layer — one hung route can never answer for its healthy
 *  siblings, and a box whose whole HTTP path is dead hangs here exactly as it
 *  hung on the request. */
export const DIAL_LIVENESS_PATH = '/__kortix/dial-liveness';

/** Registry bound — marks are per sandbox:port, so this is far above any
 *  honest concurrent-sandbox count and exists only as a leak backstop. */
const MAX_TRACKED = 1_000;

/** The probe request: the LIVENESS url on the same ingress the attempts dial
 *  (`ingressTargetUrl(ingress, DIAL_LIVENESS_PATH)` in retry.ts), with the
 *  attempt's auth headers. Without the auth headers the private edge refuses
 *  fast on its own and the answer would prove only the edge, never the box. */
export interface DialProbeTarget {
  url: string;
  headers: Record<string, string>;
}

interface DialDead {
  /** The episode this mark belongs to: a streak's timeouts extend the same
   *  episode; a clear or a stale window starts a new one. A probe's verdict
   *  settles only the episode it was asked about. */
  episodeId: number;
  /** Consecutive connect timeouts inside the streak window. */
  timeouts: number;
  /** When the last timeout was seen (streak freshness + prune age). */
  lastAtMs: number;
  /** True once the HTTP probe found no answer for the candidate. */
  confirmed: boolean;
  /** Earliest instant a request may dial again (the probe slot). */
  probeAtMs: number;
}

// replica-local: a mark only makes one replica fail fast while the others
// still dial (today's behavior, bounded); a cleared mark on one replica costs
// the others one probe window. No correctness depends on cross-replica
// agreement, so this process's copy is its own source of truth.
const dialDeadMarks = new Map<string, DialDead>();

// replica-local: a shared probe only dedupes a burst within one replica; the
// other replicas' bursts dial the box once more, bounded by the ladder.
const probesInFlight = new Map<string, Promise<void>>();

/** The probe budget a test may shorten; the production value is the constant. */
let probeBudgetMs = DIAL_PROBE_TIMEOUT_MS;

function pruneIfNeeded(nowMs: number): void {
  if (dialDeadMarks.size <= MAX_TRACKED) return;
  for (const [key, mark] of dialDeadMarks) {
    if (nowMs - mark.lastAtMs > DIAL_DEAD_STREAK_WINDOW_MS && nowMs - mark.probeAtMs > DIAL_DEAD_STREAK_WINDOW_MS) {
      dialDeadMarks.delete(key);
    }
    if (dialDeadMarks.size <= MAX_TRACKED) return;
  }
}

/** The registry key for one box port — the same key the SSE-stall mark uses. */
export function dialDeadKey(sandboxId: string, port: number): string {
  return `${sandboxId}:${port}`;
}

/** Monotone episode counter: every fresh streak (no mark, or past the streak
 *  window) opens the next one; a continuing streak keeps its mark's id. */
let episodeCounter = 0;

/** Record one connect timeout for `key`. The second inside the streak window
 *  makes the box a candidate; only the HTTP probe confirms it. A timeout of an
 *  already-confirmed box does not un-confirm it: the mark and its probe window
 *  hold, and the re-probe slot's liveness revalidation
 *  (maybeProbeDialDeadCandidate) — not the timeout — settles whether the box
 *  is still dead. */
export function recordDialTimeout(key: string, nowMs = Date.now()): void {
  const previous = dialDeadMarks.get(key);
  const fresh = !previous || nowMs - previous.lastAtMs > DIAL_DEAD_STREAK_WINDOW_MS;
  const confirmed = !fresh && previous.confirmed;
  dialDeadMarks.set(key, {
    episodeId: fresh ? ++episodeCounter : previous.episodeId,
    timeouts: (fresh ? 0 : previous.timeouts) + 1,
    lastAtMs: nowMs,
    confirmed,
    probeAtMs: confirmed ? previous.probeAtMs : 0,
  });
  pruneIfNeeded(nowMs);
}

/** A dial reached the box (any answer, even an error status): the path is
 *  proven and the mark is obsolete. */
export function clearDialDead(key: string): void {
  dialDeadMarks.delete(key);
  probesInFlight.delete(key);
}

/** Is `key` an unconfirmed candidate — two consecutive connect timeouts, the
 *  HTTP probe not settled yet? The request ladder stops on it (a third dial
 *  against a box that timed out twice buys another 15 s hang) but no request
 *  skips a dial until the probe confirms the mark: a slow handler keeps being
 *  dialled until the probe proves it answers. */
export function isDialDeadCandidate(key: string): boolean {
  const mark = dialDeadMarks.get(key);
  return !!mark && !mark.confirmed && mark.timeouts >= DIAL_DEAD_AFTER_TIMEOUTS;
}

/** Should this request skip the dial? True only for a CONFIRMED mark inside
 *  its fast-fail window. An expired window hands out the re-probe slot
 *  (renewed synchronously, so of a concurrent burst only the first caller
 *  re-probes). */
export function shouldFailFast(key: string, nowMs = Date.now()): boolean {
  const mark = dialDeadMarks.get(key);
  if (!mark || !mark.confirmed) return false;
  if (nowMs < mark.probeAtMs) return true;
  mark.probeAtMs = nowMs + DIAL_DEAD_PROBE_SPACING_MS;
  return false;
}

/** If `key` holds an unconfirmed candidate (two timeouts, no probe verdict
 *  yet), fire ONE detached HTTP probe through the ingress and confirm or clear
 *  the mark when it settles. A CONFIRMED mark re-probes the same way — the
 *  re-probe slot's request reaches this call exactly once per window, and its
 *  verdict (not the old confirmation) settles the mark: a dial timeout proves
 *  the request's route silent, never the box's HTTP layer, so a revived box
 *  whose polled route keeps hanging would stay suppressed forever without the
 *  recheck. Concurrent callers share the in-flight probe; awaiting the
 *  returned promise waits for its verdict (the request path discards it —
 *  `void`). `probeSettledAtMs` stamps a freshly confirmed mark's probe window;
 *  the request path leaves the default (the settle instant). */
export function maybeProbeDialDeadCandidate(
  key: string,
  target: DialProbeTarget,
  probeSettledAtMs = Date.now(),
): Promise<void> {
  const inFlight = probesInFlight.get(key);
  if (inFlight) return inFlight;
  const mark = dialDeadMarks.get(key);
  if (!mark || (!mark.confirmed && mark.timeouts < DIAL_DEAD_AFTER_TIMEOUTS)) return Promise.resolve();
  // The verdict belongs to THIS episode (its id, captured at start). The
  // ladder's own attempts extend the same episode — a third timeout keeps the
  // id — so the probe still settles it. A successful dial may clear the
  // episode and a fresh window may open a new one: the stale probe's silence
  // must never confirm the replacement's single timeout (review finding on
  // the fifth cut, 2026-11-12).
  const episodeId = mark.episodeId;
  const probe = probeTarget(target)
    .then((answered) => {
      if (answered) {
        // An answer clears ANY state: a concurrent dial's success outranks the
        // probe (never re-mark a cleared key), and the box's HTTP layer
        // answering the liveness path outranks an old confirmation — the
        // revived box is served again.
        dialDeadMarks.delete(key);
        return;
      }
      // Silence proves the path dead only for the episode this probe was
      // asked about. The key may hold a NEWER mark now — let its own probe
      // settle it. An already-confirmed episode keeps its confirmation and
      // window (recordDialTimeout preserved them for the re-probe) — never
      // extend, never re-mark a cleared key.
      const current = dialDeadMarks.get(key);
      if (!current || current.episodeId !== episodeId || current.confirmed) return;
      current.confirmed = true;
      current.probeAtMs = probeSettledAtMs + DIAL_DEAD_PROBE_SPACING_MS;
    })
    .catch(() => {})
    .finally(() => {
      if (probesInFlight.get(key) === probe) probesInFlight.delete(key);
    });
  probesInFlight.set(key, probe);
  return probe;
}

/** The real probe: one bounded GET through the ingress, on the liveness path —
 *  never the request's URL. The request goes out with the attempt's auth
 *  headers, so a settled response (any status, even the edge's own error)
 *  comes from the box's HTTP layer behind the same edge the attempts failed
 *  on. Anything else — a refusal, an abort at the budget, no headers — is "no
 *  answer". */
export let probeTarget: (target: DialProbeTarget) => Promise<boolean> = async (target) => {
  try {
    const response = await fetch(target.url, {
      method: 'GET',
      headers: target.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(probeBudgetMs),
    });
    void response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
};

/** The probe implementation a test stub replaces; `null` restores this one. */
let defaultProbeTarget = probeTarget;

/** Test-only: replace the HTTP probe (unit tests and the mocked e2e harness
 *  must not dial the real network; `null` restores the real probe). */
export function __setDialProbeForTests(
  probe: ((target: DialProbeTarget) => Promise<boolean>) | null,
): void {
  probeTarget = probe ?? defaultProbeTarget;
}

/** Test-only: shorten the real probe's budget for the real-topology tests
 *  (a 30 s wait has no place in a unit suite). */
export function __setDialProbeBudgetForTests(ms: number): void {
  probeBudgetMs = ms;
}

/** Test-only: drop every mark and in-flight probe, and restore the real probe
 *  and budget. */
export function __resetDialDeadForTests(): void {
  dialDeadMarks.clear();
  probesInFlight.clear();
  probeTarget = defaultProbeTarget;
  probeBudgetMs = DIAL_PROBE_TIMEOUT_MS;
}
