import { runProjectSnapshotWorkerOnce } from '../../git-proxy/project-snapshot-worker';
import { ensureProjectSnapshotBucket, projectSnapshotStorageConfigured } from '../../git-proxy/project-snapshot-store';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const IDLE_MS = 5_000;
const ERROR_MS = 15_000;

// Self-host's bundled store starts empty: no build may claim a row before the bucket exists.
let bucketReady = false;

const job = leaderTimer(
  () =>
    runWorkerTick('project-snapshots', async () => {
      let delay = IDLE_MS;
      try {
        if (!bucketReady) {
          await ensureProjectSnapshotBucket();
          bucketReady = true;
        }
        const processed = await runProjectSnapshotWorkerOnce();
        // Drain a backlog promptly; sleep only when the queue was empty.
        if (processed.length > 0) delay = 250;
      } catch (err) {
        console.error('[project-snapshot] worker tick failed', err);
        delay = ERROR_MS;
      }
      return delay;
    }),
  { name: 'project-snapshots' },
);

let started = false;

export function startProjectSnapshotWorker(): void {
  if (started) return;
  if (!projectSnapshotStorageConfigured()) {
    console.info('[project-snapshot] worker idle: KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is not configured');
    return;
  }
  started = true;
  job.start();
}

export async function stopProjectSnapshotWorker(): Promise<void> {
  if (!started) return;
  started = false;
  await job.stop();
}
