import { runAppDeploymentTick } from '../../apps/deployment-worker';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

let timer: ReturnType<typeof leaderTimer> | null = null;

export function startAppDeploymentWorker(): void {
  if (process.env.KORTIX_APPS_WORKER_ENABLED === 'false') return;
  if (timer) return;
  const interval = Math.max(1_000, Number(process.env.KORTIX_APPS_WORKER_INTERVAL_MS) || 5_000);
  timer = leaderTimer(
    async () => {
      try {
        await runWorkerTick('app-deployments', runAppDeploymentTick);
      } catch (err) {
        logger.error('[apps] deployment worker tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return interval;
    },
    { name: 'app-deployments' },
  );
  timer.start();
}

export async function stopAppDeploymentWorker(): Promise<void> {
  const stopped = timer;
  timer = null;
  await stopped?.stop();
}
