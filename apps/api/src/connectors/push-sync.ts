/**
 * A push through the git proxy that moved the default branch applies its
 * kortix.yaml now: triggers (`project_trigger_runtime`), connector policies
 * and settings, and connectors, through the same `syncProjectConnectors` the
 * UI, `kortix ship` and a change-request merge use. Without it a plain
 * `git push` waited for the periodic sweep (100 projects every 120 s), so a
 * trigger turned off in kortix.yaml kept firing for up to ~3 h.
 *
 * Per project, one sync runs at a time. A push that arrives while one runs
 * queues one more run after it, so the last push is always applied. The
 * periodic sweep stays the backstop when this fails.
 */

import { logger } from '../lib/logger';
import { errorMessage } from '../shared/error-message';

export interface PushSyncDeps {
  /** Make the mirror serve the pushed tip before the manifest read. */
  refresh: () => Promise<unknown>;
  sync: () => Promise<{ synced: number; errors: Array<{ slug: string; error: string }> }>;
}

// replica-local: a sync another replica runs is coalesced only on that replica; the sync is fenced and idempotent.
const running = new Map<string, Promise<void>>();
// replica-local: see `running`.
const again = new Set<string>();

export function syncConfigAfterPush(projectId: string, deps: PushSyncDeps): Promise<void> {
  const current = running.get(projectId);
  if (current) {
    again.add(projectId);
    return current;
  }
  const run = (async () => {
    try {
      do {
        again.delete(projectId);
        try {
          await deps.refresh();
          const result = await deps.sync();
          if (result.errors.length > 0) {
            logger.warn('[git-proxy] kortix.yaml sync after push had errors', {
              project_id: projectId,
              errors: result.errors.slice(0, 5),
            });
          }
        } catch (error) {
          logger.warn('[git-proxy] kortix.yaml sync after push failed; the periodic sweep retries', {
            project_id: projectId,
            error: errorMessage(error),
          });
        }
      } while (again.has(projectId));
    } finally {
      running.delete(projectId);
    }
  })();
  running.set(projectId, run);
  return run;
}
