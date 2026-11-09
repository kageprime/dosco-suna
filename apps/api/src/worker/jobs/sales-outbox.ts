import { processSalesOutbox } from '../../accounts/sales-outbox';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const TICK_MS = 30_000;

const job = leaderTimer(
  async () => {
    try {
      await runWorkerTick('sales-outbox', () => processSalesOutbox());
    } catch {
      logger.error('[sales-outbox] delivery tick failed');
    }
    return TICK_MS;
  },
  { name: 'sales-outbox' },
);

export const startSalesOutbox = job.start;
export const stopSalesOutbox = job.stop;
