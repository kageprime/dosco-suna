/**
 * A serial, restartable timer for a leader-only sweeper.
 *
 * `stop()` used to clear the timer and set a flag, but an in-flight tick
 * re-armed itself on finish when a fast re-acquire had already called `start()`.
 * Two chains then ran for the whole term and doubled every sweep. Each `start()`
 * and `stop()` now moves a generation counter; a tick that finishes in an older
 * generation re-arms nothing. A tick also checks the lease first (`isLeader`),
 * so a leader whose renew deadline passed writes nothing.
 *
 * A restart (`stop()` then `start()`, a lease flap) while a run is in flight
 * used to start the new chain's first run at once, beside the old one. The new
 * run now waits for the old one to settle, so two runs never overlap. A wait
 * over `SLOW_WAIT_MS` logs a warning with the timer's `name`.
 *
 * `run` returns the delay until the next tick. `stop()` clears the timer
 * before its first await and returns once the in-flight tick settles: the
 * `Job` contract (`worker/runtime/job.ts`) promises exactly that. A `wake()`
 * keeps the old delivery-loop waker racing-free: an armed delay already
 * covers the imminent tick (the old `scheduleWorker` skip armed nothing),
 * while a wake beside a run in flight arms a 0 ms timer and takes over the
 * next fire exactly as the old waker's schedule did.
 *
 * Re-arm ownership sits with whichever tick runs last: a tick that finishes
 * while another tick waits behind its run (the wake takeover) must not arm
 * its own delay over the waiter — the waiter's returned delay wins, so a
 * backlog run's `return 0` re-arms at once instead of stalling behind the
 * finishing run's armed delay. The waiter re-arms when its run ends.
 */
import { logger } from '../lib/logger';
import { isLeader } from './leader-election';

const SLOW_WAIT_MS = 10_000;

export function leaderTimer(
  run: () => Promise<number>,
  options: { firstDelayMs?: number; name?: string } = {},
): { start(): void; stop(): Promise<void>; wake(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let started = false;
  let awaiting = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const arm = (generationAtArm: number, delayMs: number) => {
    timer = setTimeout(() => void tick(generationAtArm), delayMs);
  };

  async function tick(generationAtStart: number): Promise<void> {
    timer = null;
    awaiting = true;
    const waitStarted = performance.now();
    await inFlight;
    awaiting = false;
    const waited = Math.round(performance.now() - waitStarted);
    if (waited > SLOW_WAIT_MS) logger.warn('[leader-timer] a restarted timer waited for the run before the restart', { name: options.name, ms: waited });
    if (generationAtStart !== generation || !isLeader()) return;
    let next: number;
    try {
      const running = run();
      inFlight = running.catch(() => undefined);
      next = await running;
    } catch (error) {
      logger.error('[leader-timer] tick failed', { error: error instanceof Error ? error.message : String(error) });
      next = 60_000;
    }
    // A waiting wake tick owns the next re-arm (its run may return 0 for a
    // backlog): the finishing run never arms its own delay over the waiter.
    if (generationAtStart === generation && !timer && !awaiting) arm(generationAtStart, next);
  }

  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      if (options.firstDelayMs) arm(generation, options.firstDelayMs);
      else void tick(generation);
    },
    stop() {
      started = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      // The `Job` contract: a returned promise resolves when the tick in
      // flight has finished. `inFlight` always resolves (each run's catch is
      // attached), so this never hangs.
      return inFlight.then(() => undefined);
    },
    wake() {
      // The old audit-webhook scheduleWorker: a wake never replaces an armed
      // delay, and beside a run in flight it takes over the next fire with a
      // 0 ms timer — one wake, one extra tick, never a second chain. A tick
      // already waiting behind a run counts as armed: a second wake must not
      // queue a second waiter, or the two would both resume and overlap.
      if (!started || timer || awaiting) return;
      arm(generation, 0);
    },
  };
}
