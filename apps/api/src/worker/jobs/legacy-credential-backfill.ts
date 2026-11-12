import { config } from '../../config';
import { logger } from '../../lib/logger';
import { runLegacyCredentialBackfills } from '../../secrets/legacy-credential-boot';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const DAY = 24 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;

// Leader only: the legacy credential backfills (secrets/legacy-credential-boot.ts),
// once at the start of each leadership term and then daily. A failed run
// retries in 15 min. `off` (the Kortix cloud default) arms nothing.
const worker = leaderTimer(async () => {
  try {
    await runWorkerTick('legacy-credential-backfill', () => runLegacyCredentialBackfills());
    return DAY;
  } catch (err) {
    logger.warn('[legacy-credential-backfill] run failed; retrying', { error: err instanceof Error ? err.message : String(err) });
    return RETRY_MS;
  }
}, { name: 'legacy-credential-backfill', firstDelayMs: 30_000 });

export function startLegacyCredentialBackfillWorker(): void {
  if (config.LEGACY_CREDENTIAL_BACKFILL_MODE === 'off') return;
  worker.start();
}
export const stopLegacyCredentialBackfillWorker = worker.stop;
