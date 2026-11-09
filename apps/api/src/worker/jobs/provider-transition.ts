import { logger } from '../../lib/logger';
import { runProviderTransitionTick } from '../../projects/provider-transition/provider-transition-worker';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

function intervalMs(): number {
  const raw = Number(process.env.KORTIX_PROVIDER_TRANSITION_WORKER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

let timer: ReturnType<typeof leaderTimer> | null = null;

export function startProviderTransitionWorker(): void {
  if (process.env.KORTIX_PROVIDER_TRANSITION_WORKER_ENABLED === 'false') return;
  if (timer) return;
  const interval = intervalMs();
  timer = leaderTimer(
    async () => {
      try {
        await runWorkerTick('provider-transition', runProviderTransitionTick);
      } catch (err) {
        logger.error('[provider-transition-worker] tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return interval;
    },
    { firstDelayMs: interval, name: 'provider-transition' },
  );
  timer.start();
}

export async function stopProviderTransitionWorker(): Promise<void> {
  const stopped = timer;
  timer = null;
  await stopped?.stop();
}
