import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { inPlatinumBackgroundLane } from '../../shared/platinum-write-lane';
import { leaderTimer } from '../../shared/leader-timer';
import {
  type ActiveTurnRenewalDependencies,
  activeTurnRenewalIntervalMs,
  runActiveTurnRenewal,
} from '../../projects/active-turn-renewal';

let job: ReturnType<typeof leaderTimer> | null = null;

export function startActiveTurnRenewal(
  dependencies: ActiveTurnRenewalDependencies = {},
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  if (env.KORTIX_ACTIVE_TURN_RENEWAL_ENABLED === 'false') return;
  if (job) return;
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
  const nextDelayMs = (startedAtMs: number): number => {
    const intervalMs = (dependencies.intervalMs ?? activeTurnRenewalIntervalMs)();
    return Math.max(0, intervalMs - (monotonicNowMs() - startedAtMs));
  };
  job = leaderTimer(
    async () => {
      const startedAtMs = monotonicNowMs();
      try {
        // Each renewal is a Platinum `exec` (a write): paced with the maintenance sweeps.
        const result = await runWorkerTick('active-turn-renewal', () =>
          inPlatinumBackgroundLane(() => runActiveTurnRenewal(dependencies)),
        );
        if (result.candidates > 0 || result.errors > 0 || result.transient > 0) {
          logger.info('[active-turn-renewal] pass', {
            candidates: result.candidates,
            matching: result.matching,
            deferred: result.deferred,
            lifecycleRenewed: result.lifecycleRenewed,
            reconciled: result.reconciled,
            errors: result.errors,
            transient: result.transient,
          });
        }
      } catch (error) {
        logger.error('[active-turn-renewal] pass failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return nextDelayMs(startedAtMs);
    },
    { name: 'active-turn-renewal' },
  );
  job.start();
}

export async function stopActiveTurnRenewal(): Promise<void> {
  const renewal = job;
  job = null;
  await renewal?.stop();
}
