// Singleton drive workers (scheduler leader only):
//
// - the conflict scanner (see drives/conflicts.ts);
// - the volume deletion queue: `kortix.platinum_volume_deletions` holds every
//   volume whose owner row is gone (a drive), with its region. A
//   trigger fills it on every delete path, cascades included; this drains it,
//   each delete in the volume's own region. A volume still held by a sandbox
//   answers 409 and is retried with backoff.
// - the revocation retry: a session sandbox whose folder access narrowed but
//   whose detach did not land is brought in line again until it does.
// - the search indexer (see drives/search-index/indexer.ts): keeps the index
//   of every project drive equal to its volume head.

import { logger } from '../../lib/logger';
import { platinumVolumeDeletions } from '@kortix/db';
import { asc, eq, lte, sql } from 'drizzle-orm';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';
import { db } from '../../shared/db';
import { configuredTimeoutMs } from '../../shared/with-timeout';
import { runConflictScan } from '../../drives/conflicts';
import { DRIVE_INDEX_PASS_MS, runDriveIndexPass } from '../../drives/search-index/indexer';
import { DriveStorageError, deleteDriveVolume, driveStorageAvailable } from '../../drives/volumes';

const SCAN_MS = configuredTimeoutMs('KORTIX_DRIVE_CONFLICT_SCAN_MS', 15_000, 2_000);
const DRAIN_MS = configuredTimeoutMs('KORTIX_VOLUME_DELETE_DRAIN_MS', 30_000, 5_000);
const MAX_BACKOFF_MS = 60 * 60_000;

let draining = false;
let retryingRevocations = false;

// Four fixed-cadence timers, genuinely independent of a tick's duration.
const scanSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('drive-conflict-scan', runConflictScan);
    } catch (err) {
      logger.warn('[drives] conflict scan pass failed:', { error: err instanceof Error ? err.message : String(err) });
    }
    return SCAN_MS;
  },
  { firstDelayMs: SCAN_MS, name: 'drive-conflict-scan' },
);
const drainSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('volume-deletions', () => drainVolumeDeletions());
    } catch (err) {
      logger.warn('[drives] volume deletion pass failed:', { error: err instanceof Error ? err.message : String(err) });
    }
    return DRAIN_MS;
  },
  { firstDelayMs: DRAIN_MS, name: 'volume-deletions' },
);
/** How often a revocation whose detach did not land is tried again (each row backs off on its own). */
const REVOCATION_TICK_MS = 15_000;
const revocationSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('drive-mount-revocations', retryPendingRevocations);
    } catch (err) {
      logger.warn('[drives] revocation retry pass failed:', { error: err instanceof Error ? err.message : String(err) });
    }
    return REVOCATION_TICK_MS;
  },
  { firstDelayMs: REVOCATION_TICK_MS, name: 'drive-mount-revocations' },
);
const indexSweeper = leaderTimer(
  async () => {
    try {
      await runWorkerTick('drive-index', runDriveIndexPass);
    } catch (err) {
      logger.warn('[drives] search index pass failed:', { error: err instanceof Error ? err.message : String(err) });
    }
    return DRIVE_INDEX_PASS_MS;
  },
  { firstDelayMs: DRIVE_INDEX_PASS_MS, name: 'drive-index' },
);

export async function drainVolumeDeletions(limit = 20): Promise<{ deleted: number; deferred: number }> {
  if (draining || !driveStorageAvailable()) return { deleted: 0, deferred: 0 };
  draining = true;
  let deleted = 0;
  let deferred = 0;
  try {
    const due = await db
      .select()
      .from(platinumVolumeDeletions)
      .where(lte(platinumVolumeDeletions.notBefore, new Date()))
      .orderBy(asc(platinumVolumeDeletions.notBefore))
      .limit(limit);
    for (const row of due) {
      try {
        await deleteDriveVolume({ name: row.volumeName, region: row.region ?? null, unfenced: true });
        await db.delete(platinumVolumeDeletions).where(eq(platinumVolumeDeletions.volumeName, row.volumeName));
        deleted++;
        logger.info(`[drives] deleted volume ${row.volumeName} (${row.reason})`);
      } catch (err) {
        deferred++;
        const backoff = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(row.attempts, 10));
        const message = err instanceof DriveStorageError ? `${err.status} ${err.code ?? ''} ${err.message}` : String(err);
        await db
          .update(platinumVolumeDeletions)
          .set({
            attempts: sql`${platinumVolumeDeletions.attempts} + 1`,
            lastError: message.slice(0, 500),
            notBefore: new Date(Date.now() + backoff),
          })
          .where(eq(platinumVolumeDeletions.volumeName, row.volumeName));
      }
    }
  } finally {
    draining = false;
  }
  return { deleted, deferred };
}

/** One pass over the revocations whose mounts are not in line yet (see drives/service.ts). */
export async function retryPendingRevocations(): Promise<void> {
  if (retryingRevocations) return;
  retryingRevocations = true;
  try {
    const { retryMountRevocations } = await import('../../drives/service');
    const { retried, failed } = await retryMountRevocations();
    if (retried) logger.info(`[drives] revocation retry: ${retried} sandbox(es), ${failed} still pending`);
  } finally {
    retryingRevocations = false;
  }
}

export function startDriveWorkers(): void {
  if (!driveStorageAvailable()) return;
  scanSweeper.start();
  drainSweeper.start();
  revocationSweeper.start();
  indexSweeper.start();
}

export async function stopDriveWorkers(): Promise<void> {
  await Promise.all([scanSweeper.stop(), drainSweeper.stop(), revocationSweeper.stop(), indexSweeper.stop()]);
}
