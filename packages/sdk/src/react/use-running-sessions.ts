'use client';

import { useQuery } from '@tanstack/react-query';
import { listWorkspaceSessionsPage, type ProjectSession } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** The most running sessions one read lists. */
export const RUNNING_SESSIONS_LIMIT = 100;

/** While the list is on screen. */
const OPEN_POLL_MS = 5_000;
/** While something runs: the count changes as runs end. */
const BUSY_POLL_MS = 15_000;
/** While nothing runs: only a new run can change the answer, and it should show within ~20 s. */
const IDLE_POLL_MS = 20_000;

/**
 * The sessions of a workspace that work now (`working=only`): every session
 * with a live turn, workflow runners and their agents and colleagues
 * included. One page of up to {@link RUNNING_SESSIONS_LIMIT}. It polls every
 * 5 s while `open` (the list is on screen), every 15 s while any session
 * runs, every 20 s otherwise, and never in a background tab.
 */
export function useRunningSessions(
  projectId: string | null | undefined,
  options: { enabled?: boolean; open?: boolean } = {},
) {
  return useQuery({
    queryKey: qk.project.runningSessions(projectId ?? ''),
    // The server's own rule, again here: an API older than `working=only` ignores it and lists every session.
    queryFn: async (): Promise<ProjectSession[]> =>
      (await listWorkspaceSessionsPage(projectId as string, { working: true, limit: RUNNING_SESSIONS_LIMIT })).items.filter(
        (session) => session.working?.state === 'working',
      ),
    enabled: !!projectId && options.enabled !== false,
    ...contract('inventory'),
    refetchInterval: (state: { state: { data?: ProjectSession[] } }) =>
      options.open ? OPEN_POLL_MS : (state.state.data?.length ?? 0) > 0 ? BUSY_POLL_MS : IDLE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
