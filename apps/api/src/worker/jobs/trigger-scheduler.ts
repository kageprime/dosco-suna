import { config } from '../../config';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';
import { runProjectTriggerSchedulerTick } from '../../projects/lib/trigger-scheduler';
import { schedulerSweepIsStale, triggerSchedulerIntervalMs } from '../../projects/lib/trigger-scheduler-state';

let timer: ReturnType<typeof leaderTimer> | null = null;

export function startProjectTriggerScheduler(): void {
  if (config.KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (timer) return;
  const interval = triggerSchedulerIntervalMs();
  timer = leaderTimer(
    async () => {
      try {
        // Everything the tick starts (sweep, drains, connector reconcile) inherits
        // the worker context through AsyncLocalStorage.
        await runWorkerTick('trigger-scheduler', runProjectTriggerSchedulerTick);
      } catch (error) {
        logger.error('[trigger-scheduler] tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return interval;
    },
    { name: 'trigger-scheduler' },
  );
  timer.start();
}

export function stopProjectTriggerScheduler(): Promise<void> {
  const stopped = timer;
  timer = null;
  return stopped?.stop() ?? Promise.resolve();
}

/** True while the trigger sweep, which a tick starts but does not await, has stalled. */
export function triggerSweepStalled(): boolean {
  return schedulerSweepIsStale(true);
}
