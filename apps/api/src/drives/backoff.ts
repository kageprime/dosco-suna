// Per-drive retry backoff shared by the drive sweeps (the conflict scanner,
// the search indexer): after a failure a drive waits 30 s doubling to `maxMs`
// (longer when storage names a Retry-After), a pass skips the drives still
// waiting, and a success clears the count. Replica-local: a new leader tries
// every drive once more before backing off again.
//
// The sweeps warn on the FIRST failure only (learnings 2026-09-28, KRTX-614
// and KRTX-338: never one warning per retry attempt — the warn marks the
// transition into the failing state, and a success re-arms it), so a Platinum
// degradation cannot become a warn-log spike two lines per drive per pass.
import { DriveStorageError } from './volumes';

/**
 * Per-drive retry backoff for one drive sweep: `fail` records a failure — the
 * drive is skipped until the returned `waitMs` elapses, and `firstFailure` is
 * false while the drive was already failing (the state persisted, so the
 * caller stays quiet). `waiting(now)` lists the drives still waiting at
 * `now`; `ok` clears a drive, so its next failure warns again.
 */
export function createDriveBackoff(maxMs: number) {
  const map = new Map<string, { attempts: number; until: number }>();
  return {
    fail(driveId: string, err: unknown) {
      const prev = map.get(driveId);
      const attempts = prev?.attempts ?? 0;
      const retryAfter = err instanceof DriveStorageError && err.retryAfterSeconds ? err.retryAfterSeconds * 1_000 : 0;
      const waitMs = Math.min(maxMs, Math.max(retryAfter, 30_000 * 2 ** Math.min(attempts, 10)));
      map.set(driveId, { attempts: attempts + 1, until: Date.now() + waitMs });
      return { waitMs, firstFailure: prev === undefined };
    },
    waiting(now = Date.now()) {
      // Read-only: an elapsed entry stays until its drive succeeds (ok), so
      // the attempts count and the first-failure state survive the wait.
      const waiting = new Set<string>();
      for (const [id, b] of map) if (b.until > now) waiting.add(id);
      return waiting;
    },
    ok(driveId: string) {
      map.delete(driveId);
    },
  };
}
