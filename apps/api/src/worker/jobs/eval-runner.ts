import { logger } from '../../lib/logger';
import { runEvalRunnerTick } from '../../projects/surface';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

/** While a trial is open the runner looks again after 3 s; with none, after 15 s (projects/evals/runner.ts). */
const BUSY_MS = 3_000;
const IDLE_MS = 15_000;

// Serial ticks, one chain per leadership term (shared/leader-timer.ts): one process advances a trial at a time.
const runner = leaderTimer(async () => {
  let advanced = 0;
  try {
    await runWorkerTick('eval-runner', async () => {
      advanced = await runEvalRunnerTick();
      return advanced;
    });
  } catch (err) {
    logger.error('[evals] runner tick failed', { error: String(err) });
  }
  return advanced > 0 ? BUSY_MS : IDLE_MS;
});

export const startEvalRunner = runner.start;
export const stopEvalRunner = runner.stop;
