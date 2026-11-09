import { runAppIdleReaper, runAppKeepAlive } from '../../apps/idle-reaper';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

let timers: Array<ReturnType<typeof leaderTimer>> = [];

export function startAppIdleReaper(): void {
  if (process.env.KORTIX_APPS_IDLE_REAPER_ENABLED === 'false') return;
  if (timers.length) return;
  const interval = Math.max(5_000, Number(process.env.KORTIX_APPS_IDLE_REAPER_INTERVAL_MS) || 30_000);
  const reaper = leaderTimer(
    async () => {
      try {
        await runWorkerTick('app-idle-reaper', runAppIdleReaper);
      } catch (err) {
        logger.error('[apps] idle reaper failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return interval;
    },
    { firstDelayMs: interval, name: 'app-idle-reaper' },
  );
  // Its own guard and its own 5-minute cadence: a slow always-on start never
  // holds up an idle stop.
  const keepAlive = leaderTimer(
    async () => {
      try {
        await runWorkerTick('app-keep-alive', runAppKeepAlive);
      } catch (err) {
        logger.error('[apps] keep-alive pass failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return interval;
    },
    { firstDelayMs: interval, name: 'app-keep-alive' },
  );
  timers = [reaper, keepAlive];
  for (const timer of timers) timer.start();
}

export async function stopAppIdleReaper(): Promise<void> {
  const stopped = timers;
  timers = [];
  await Promise.all(stopped.map((timer) => timer.stop()));
}
