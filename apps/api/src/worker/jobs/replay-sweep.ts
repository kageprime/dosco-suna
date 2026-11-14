// Expired shared Idempotency-Key answers (KRTX-4612): one leader-only chain deletes them.

import { logger } from '../../lib/logger';
import { sweepExpiredReplays } from '../../llm-gateway/idempotency-replays';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const TICK_MS = 10 * 60_000;

const sweeper = leaderTimer(async () => {
  try {
    const gone = await runWorkerTick('gateway-replay-sweep', () => sweepExpiredReplays());
    if (gone) logger.info('[gateway replay sweep] deleted', { gone });
  } catch (err) {
    logger.warn('[gateway replay sweep] tick failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return TICK_MS;
});

export const startReplaySweeper = sweeper.start;
export const stopReplaySweeper = sweeper.stop;
