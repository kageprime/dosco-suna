'use client';

import type { QueryClient } from '@tanstack/react-query';

import { sessionStartKey, startWorkspaceSession } from '../core/rest/projects-client';

/**
 * Begin the session runtime boot DURING the route transition (before the session
 * page mounts), so provisioning overlaps navigation instead of starting after the
 * page paints. Idempotent: React Query dedupes against the session page's own
 * query (same key, same long-poll), and `/start` is idempotent server-side. Also warms the route
 * bundle. Use at every createProjectSession→navigate site.
 *
 * Returns the prefetch promise (it never rejects — `prefetchQuery` swallows
 * errors) so a caller can sequence work on `/start` having settled.
 * Fire-and-forget callers just ignore the return.
 */
export function prefetchSessionStart(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    // The same server long-poll the session page sends (`useSession` `waitMs`):
    // the page mounts while this read is in flight and joins it. A one-shot
    // read answered in ~0.5 s, and the page then sent its own long-poll.
    queryFn: () => startWorkspaceSession(projectId, sessionId, { waitMs: SESSION_START_WAIT_MS }),
    // An answer read this instant is not read again by a second prefetch.
    staleTime: PREFETCH_START_FRESH_MS,
  });
}

/** How long `/start` holds the request until the box is ready (`useSession`'s default `waitMs`). */
export const SESSION_START_WAIT_MS = 15_000;
/** A `/start` answer younger than this is not prefetched again. */
const PREFETCH_START_FRESH_MS = 2_000;
