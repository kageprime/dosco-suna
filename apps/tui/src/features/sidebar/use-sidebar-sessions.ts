/**
 * The sidebar's session reads: web's split (KRTX-4898). The server buckets
 * runs by who started them (`started_by=me|others|automated`); each bucket also
 * holds its runs' children, which the sidebar nests under their parent.
 */

import type { ProjectSession } from '@kortix/sdk';
import { qk, useProjectSessions } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/** Statuses that mean the row is still moving, so the list is worth polling. */
const LIVE_STATUSES = new Set(['queued', 'branching', 'provisioning', 'running']);
export const LIVE_POLL_MS = 5000;
/** Rows a page of the Shared and Automated sections reads (web's side sections). */
const SIDE_SECTION_PAGE_SIZE = 20;

// Poll only while a row is still moving — the same bound `apps/web` uses. A
// settled list costs one request per mount.
const pollWhileLive = (sessions: ProjectSession[]) =>
  sessions.some((session) => LIVE_STATUSES.has(session.status)) ? LIVE_POLL_MS : false;

/**
 * Refetch every session list of the project: the sidebar's three buckets and
 * the unfiltered list the app header and `/sessions` read. Each list is its own
 * cache entry under `sessionsScope`, so a refetch of one never reaches the rest.
 */
export function useRefreshSessions(projectId: string | null) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    if (projectId) await queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
  }, [queryClient, projectId]);
}

export function useSidebarSessions(projectId: string | null) {
  const enabled = Boolean(projectId);
  const mine = useProjectSessions(projectId ?? '', { startedBy: 'me', enabled, refetchInterval: pollWhileLive });
  const shared = useProjectSessions(projectId ?? '', {
    startedBy: 'others',
    limit: SIDE_SECTION_PAGE_SIZE,
    enabled,
    refetchInterval: pollWhileLive,
  });
  const automated = useProjectSessions(projectId ?? '', {
    startedBy: 'automated',
    limit: SIDE_SECTION_PAGE_SIZE,
    enabled,
    refetchInterval: pollWhileLive,
  });
  return { mine, shared, automated, refresh: useRefreshSessions(projectId) };
}
