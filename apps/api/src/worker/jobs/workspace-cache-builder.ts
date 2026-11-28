import { logger } from '../../lib/logger';
import { runWorkspaceCacheBuilderTick } from '../../projects/surface';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

/** A build in flight is looked at every minute; otherwise every 10 min (projects/workspace-cache/builder.ts). */
const BUSY_MS = 60_000;
const IDLE_MS = 10 * 60_000;

// Serial ticks, one chain per leadership term (shared/leader-timer.ts): one process advances a build at a time.
const builder = leaderTimer(async () => {
  let advanced = 0;
  try {
    await runWorkerTick('workspace-cache-builder', async () => {
      advanced = await runWorkspaceCacheBuilderTick();
      return advanced;
    });
  } catch (err) {
    logger.error('[workspace-cache] builder tick failed', { error: String(err) });
  }
  return advanced > 0 ? BUSY_MS : IDLE_MS;
});

export const startWorkspaceCacheBuilder = builder.start;
export const stopWorkspaceCacheBuilder = builder.stop;
