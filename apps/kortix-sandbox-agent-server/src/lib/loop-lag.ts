/**
 * Event-loop lag of the box's daemon, sampled by a timer the loop itself
 * runs. A `setInterval` tick runs late only when something blocks the loop —
 * a boot reconcile, an agent turn, a log re-serialization — and the missed
 * wall is the stall. That number is the missing half of the /pending latency
 * attribution (KRTX-4459): the API saw `upstream_ms ≈ http;dur ≈ the whole
 * request` on every slow row, but could never tell a stalled daemon process
 * from an ingress edge that ate the time, because the box shipped no
 * measurement. This module is that measurement, stamped onto every
 * `/kortix/runtime/*` turn-verb answer as `Server-Timing: lag;dur=…`.
 */

const SAMPLE_MS = 250
/** The peak is the worst slip of the 15 s after the last stall, then folds out. */
const PEAK_WINDOW_MS = 15_000

let peakMs = 0
let peakAtMs = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

/** Fold one observed slip (ms past the scheduled tick) into the peak.

The window is "15 s after the last NON-ZERO slip": the timer itself
produces a ~0 slip on every healthy tick, so refreshing on each tick would
label a stall permanent. Only a stall restarts the window; a clean window
folds the peak to zero and the next stall starts a fresh one. */
export function observeLoopLag(lateMs: number, now = Date.now()): void {
  const late = Math.max(0, lateMs)
  if (peakMs > 0 && now - peakAtMs >= PEAK_WINDOW_MS) {
    peakMs = 0
    peakAtMs = now
  }
  if (late > peakMs) {
    peakMs = late
    peakAtMs = now
  }
}

/** The peak slip of the current window: 0 is "nothing the loop reported". */
export function loopLagMs(): number {
  startSampling()
  return Math.max(0, Math.round(peakMs))
}

/** Start the timer once, on first read — a daemon that serves nothing samples
 *  nothing. `startProxy` starts it at server entry, so a stall in the boot
 *  window or a pre-first-request turn is still counted. */
export function startSampling(): void {
  if (timer) return
  let nextAt = Date.now() + SAMPLE_MS
  timer = setInterval(() => {
    const now = Date.now()
    if (now >= nextAt) observeLoopLag(now - nextAt, now)
    nextAt = now + SAMPLE_MS
  }, SAMPLE_MS)
  void timer.unref?.()
}

/** Test seam: drop the peak and the timer so a test file starts clean. */
export function resetLoopLagSampleForTests(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  peakMs = 0
  peakAtMs = Date.now()
}
