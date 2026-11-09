import {
  runFreeTierCreditRotation,
  runSubprocessorNotices,
  runTrialExpirySweep,
  runYearlyCreditRotation,
} from '../../billing/rotation-schedule';
import { config } from '../../config';
import { runWorkerTick } from '../../shared/audit-scope';
import { logger } from '../../lib/logger';
import { leaderTimer } from '../../shared/leader-timer';

// The hourly billing sweeps. bootstrap.ts starts them with the other singleton
// workers, so they run on the elected leader only, not on every replica.
const HOUR_MS = 60 * 60 * 1000;

const trialExpirySweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('billing-trial-expiry', runTrialExpirySweep);
    } catch (err) {
      logger.error('[BillingApp] sweep tick failed', { sweep: 'trial expiry', error: err instanceof Error ? err.message : String(err) });
    }
    return HOUR_MS;
  },
  { firstDelayMs: HOUR_MS, name: 'trial expiry' },
);
const yearlyRotationSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('billing-yearly-rotation', runYearlyCreditRotation);
    } catch (err) {
      logger.error('[BillingApp] sweep tick failed', { sweep: 'yearly rotation', error: err instanceof Error ? err.message : String(err) });
    }
    return HOUR_MS;
  },
  { firstDelayMs: HOUR_MS, name: 'yearly rotation' },
);
const freeTierRotationSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('billing-free-tier-rotation', runFreeTierCreditRotation);
    } catch (err) {
      logger.error('[BillingApp] sweep tick failed', { sweep: 'free-tier rotation', error: err instanceof Error ? err.message : String(err) });
    }
    return HOUR_MS;
  },
  { firstDelayMs: HOUR_MS, name: 'free-tier rotation' },
);
const subprocessorNoticesSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('legal-subprocessor-notices', runSubprocessorNotices);
    } catch (err) {
      logger.error('[BillingApp] sweep tick failed', { sweep: 'subprocessor notices', error: err instanceof Error ? err.message : String(err) });
    }
    return HOUR_MS;
  },
  { firstDelayMs: HOUR_MS, name: 'subprocessor notices' },
);

let timers: Array<ReturnType<typeof leaderTimer>> = [];

export function startBillingRotation(): void {
  if (timers.length || !config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  timers = [trialExpirySweeper, yearlyRotationSweeper, freeTierRotationSweeper, subprocessorNoticesSweeper];
  for (const timer of timers) timer.start();
}

export async function stopBillingRotation(): Promise<void> {
  const stopped = timers;
  timers = [];
  await Promise.all(stopped.map((timer) => timer.stop()));
}
