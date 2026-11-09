/**
 * Dosco Capture's leader-only loops (capture/workers.ts holds the ticks):
 *   capture-index-reader   every KORTIX_CAPTURE_INDEX_POLL_SECONDS: each active device's index and status
 *   capture-maintenance    every 5 min: partitions, retention, prune grants and jobs
 *   capture-store-bucket   only with KORTIX_CAPTURE_S3_CREATE_BUCKET: creates the bucket of the bundled store
 *   capture-events-reader  only with KORTIX_CAPTURE_SQS_QUEUE_URL: long-polls the bucket's manifest events
 * A failing tick waits at least 30 s, so a missing permission or a store outage never spins.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { ensureCaptureBucket } from '../../capture/store';
import { captureMaintenance, pollAllDevices, receiveEvents } from '../../capture/workers';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

let loops: Array<ReturnType<typeof leaderTimer>> = [];

function loop(name: string, everyMs: () => number, tick: () => Promise<unknown>) {
  return leaderTimer(
    async () => {
      let delay = everyMs();
      try {
        await tick();
      } catch (error) {
        delay = Math.max(delay, 30_000);
        logger.error(`[capture] ${name} tick failed`, { error: String(error) });
      }
      return delay;
    },
    { firstDelayMs: 1_000, name },
  );
}

export function startCaptureWorkers(): void {
  if (loops.length) return;
  if (config.KORTIX_CAPTURE_S3_CREATE_BUCKET) loops.push(loop('capture-store-bucket', () => 60_000, () => runWorkerTick('capture-store-bucket', ensureCaptureBucket)));
  loops.push(loop('capture-index-reader', () => config.KORTIX_CAPTURE_INDEX_POLL_SECONDS * 1000, () => runWorkerTick('capture-index-reader', pollAllDevices)));
  loops.push(loop('capture-maintenance', () => 5 * 60_000, () => runWorkerTick('capture-maintenance', captureMaintenance)));
  // Long polling waits up to 20 s inside the call; the loop re-arms at once.
  if ((config.KORTIX_CAPTURE_SQS_QUEUE_URL ?? '').trim()) {
    loops.push(loop('capture-events-reader', () => 0, () => runWorkerTick('capture-events-reader', receiveEvents)));
  }
  for (const l of loops) l.start();
}

export async function stopCaptureWorkers(): Promise<void> {
  const stopped = loops.splice(0);
  await Promise.all(stopped.map((l) => l.stop()));
}
