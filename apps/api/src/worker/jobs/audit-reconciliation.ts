import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';
import {
  type AuditReconciliationFailureState,
  activePageDelayMs,
  AuditReconciliationPageError,
  nextAuditReconciliationCursor,
  nextAuditReconciliationFailureDecision,
  runAuditReconciliationPage,
} from '../../shared/audit-reconciliation-worker';

const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 60_000;

let lastScannedAccountId: string | null = null;
let failureState: AuditReconciliationFailureState = { consecutiveFailures: 0, failingAccountId: null };

const job = leaderTimer(
  () =>
    runWorkerTick('audit-reconciliation', async () => {
      try {
        const pageStartedAt = Date.now();
        const previousAccountId = lastScannedAccountId;
        const page = await runAuditReconciliationPage(previousAccountId);
        failureState = { consecutiveFailures: 0, failingAccountId: null };
        if (page.accountId) {
          // Do not advance past an account while it still has another bounded
          // source-ledger page. Advancing here limited a large backfill to one
          // page per full account scan (and one scan per idle interval).
          lastScannedAccountId = nextAuditReconciliationCursor(previousAccountId, page);
          // Self-paced duty cycle: a page that just cost N ms of database
          // re-fires no sooner than N ms later (activePageDelayMs).
          return activePageDelayMs(Date.now() - pageStartedAt, ACTIVE_DELAY_MS);
        } else {
          lastScannedAccountId = null;
          return IDLE_DELAY_MS;
        }
      } catch (error) {
        const failedAccountId = error instanceof AuditReconciliationPageError ? error.accountId : null;
        const decision = nextAuditReconciliationFailureDecision(failureState, failedAccountId);
        failureState = decision.state;
        if (decision.skipToAccountId) {
          console.warn(
            '[audit-reconciliation] skipping account after repeated failures',
            decision.skipToAccountId,
          );
          lastScannedAccountId = decision.skipToAccountId;
        }
        console.warn(
          '[audit-reconciliation] page failed',
          error instanceof Error ? error.message : String(error),
        );
        return decision.delayMs;
      }
    }),
  { name: 'audit-reconciliation' },
);

export function startAuditReconciliationWorker(): void {
  lastScannedAccountId = null;
  failureState = { consecutiveFailures: 0, failingAccountId: null };
  job.start();
}

export function stopAuditReconciliationWorker(): Promise<void> {
  lastScannedAccountId = null;
  failureState = { consecutiveFailures: 0, failingAccountId: null };
  return job.stop();
}
