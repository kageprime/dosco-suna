import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

// Executes due scheduled deletions: account requests
// (`kortix.account_deletion_requests`, including closed workspaces at the end
// of their 14-day grace) and person requests (`kortix.person_deletion_requests`,
// "Delete my account", processScheduledPersonDeletions). The only processor of
// `kortix.account_deletion_requests`: the Supabase pg_cron job that used to
// own this read the pre-baseline legacy `public` copy of the table (migration
// 20260924205551453 kept its function alive for that job), so nothing has
// executed since the schema moved to `kortix`. bootstrap.ts starts this with
// the other singleton workers, on the elected leader only. The first tick
// runs immediately so a new leader drains the backlog it inherited; afterwards
// one pass every 15 minutes. The auth-user-delete trigger schedules orphan
// accounts as due-now requests, so a daily pass would leave them unreachable
// (403) for up to a day. Idle ticks cost one indexed read. Runs with billing
// off too: self-hosted deployments request deletions through the same routes,
// and the auth-user-delete trigger schedules orphan accounts on every
// deployment.
const TICK_MS = 15 * 60 * 1000;

const job = leaderTimer(
  async () => {
    try {
      await runWorkerTick('account-deletion', async () => {
        const { processScheduledDeletions, SWEEP_BATCH_SIZE } = await import('../../billing/services/account-deletion');
        await processScheduledDeletions();
        // "Delete my account" requests: their own table, after the account requests.
        // Paused with the account sweep (ACCOUNT_DELETION_SWEEP_PAUSED).
        const { config } = await import('../../config');
        if (config.ACCOUNT_DELETION_SWEEP_PAUSED) return;
        const { processScheduledPersonDeletions } = await import('../../workspaces/surface');
        const people = await processScheduledPersonDeletions(SWEEP_BATCH_SIZE);
        logger.info(`[PersonDeletion] Processed: ${people.processed}, Errors: ${people.errors.length}`);
      });
    } catch (err) {
      // The catch wraps runWorkerTick so a failing sweep settles the tick as
      // an error and the heartbeat's lastOkAt stays behind (StaleJobs alarm).
      logger.error('[AccountDeletion] scheduled deletion tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return TICK_MS;
  },
  { name: 'account-deletion' },
);

export const startAccountDeletionSchedule = job.start;
export const stopAccountDeletionSchedule = job.stop;
