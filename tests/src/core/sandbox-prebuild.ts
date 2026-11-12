/**
 * The sandbox pre-build's session create (tests/src/core/runner.ts).
 *
 * Bounded retry ONLY on the API's own typed PRE-COMMIT degradations, which
 * `.status()` raises as `Ke2eRetryableError` with `ke2ePreCommit: true` — the
 * git mirror's cold-clone `git_mirror_unavailable` and a `retry: true` 5xx,
 * both declared pre-commit by the response body itself.
 *
 * NOT a flow, so no flow-level budget exists to honor the mark: without this
 * retry one transient mirror blip red-gated the whole release
 * (run 42666114535 attempt 3: 503 GitOperationError at 17:54:38, thirty
 * seconds after the provision returned 201).
 *
 * AMBIGUOUS marked errors are never replayed here: an edge-laundered
 * synthetic 503 or a network failure may have been committed at the origin,
 * and re-sending the create would duplicate the resource (the create-replay-
 * safety contract — REPLAY_SAFE_METHODS). They fail the pre-build as-is. The
 * proven shapes are pre-insert, so the re-send cannot duplicate a session row.
 */
import type { Client, Res } from './client';
import { isKe2ePreCommitRetryableError, ke2eRetryDelayMs } from './client';
import { log } from './log';
import { sleep } from './poll';

export const SANDBOX_PREBUILD_CREATE_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 15_000;

export async function postSessionWithRetry(
  client: Client,
  project: { id: string },
): Promise<Res> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await client.post('/v1/projects/:projectId/sessions', {},
        { params: { projectId: project.id } });
      return response.status(201);
    } catch (error) {
      const nextAttempt = attempt + 1;
      if (
        !isKe2ePreCommitRetryableError(error) ||
        nextAttempt > SANDBOX_PREBUILD_CREATE_ATTEMPTS
      ) {
        throw error;
      }
      const delayMs = Math.min(ke2eRetryDelayMs(error), MAX_RETRY_DELAY_MS);
      log.warn(
        `sandbox pre-build create retryable; ` +
          `re-sending (attempt ${nextAttempt}/${SANDBOX_PREBUILD_CREATE_ATTEMPTS}) in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }
}
