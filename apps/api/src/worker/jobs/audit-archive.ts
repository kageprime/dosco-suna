// Serial daily audit archive, one chain per leadership term (shared/leader-timer.ts).
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { runAuditArchiveOnce } from '../../shared/audit-archive/worker';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const TICK_MS = 24 * 3_600_000;
const FIRST_TICK_MS = 10 * 60_000;
/** A pass that spent its budget with weeks left (a backlog) continues after this pause, not in 24 h. */
const CONTINUE_MS = 60_000;

const worker = leaderTimer(
  async () => {
    try {
      const outcome = await runWorkerTick('audit-archive', runAuditArchiveOnce);
      if (outcome?.ran && outcome.pending) {
        logger.info('[audit archive] pass paused at its budget; the next pass continues in 60 s', { outcome });
        return CONTINUE_MS;
      }
      if (outcome?.ran) logger.info('[audit archive] pass finished', { outcome });
      else if (outcome && config.AUDIT_ARCHIVE_ENABLED) logger.warn('[audit archive] skipped', { reason: outcome.reason });
    } catch (err) {
      logger.error('[audit archive] pass failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
    }
    return TICK_MS;
  },
  { firstDelayMs: FIRST_TICK_MS, name: 'audit-archive' },
);

export const startAuditArchiveWorker = worker.start;
export const stopAuditArchiveWorker = worker.stop;
