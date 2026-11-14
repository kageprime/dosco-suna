'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { readCachedWorkspaceSessions } from './session-cache-write';

/**
 * The cached rows of `sessionIds` in this project: the rows the session lists
 * (the sidebar's polled pages) and single-session reads already hold, the
 * freshest when several do (`readCachedWorkspaceSessions`). It fetches nothing,
 * so a host that shows a session's title or status outside the list (a tab, a
 * chip) stays in step with the list for free; a session in no cache is absent.
 *
 * The map keeps its identity until one of these rows changes. The hook wakes
 * only for data events under this project's sessions prefix (which includes
 * the turn and prompt caches: a wake there re-reads and re-renders nothing).
 */
export function useCachedWorkspaceSessions(
  projectId: string,
  sessionIds: readonly string[],
): ReadonlyMap<string, ProjectSession> {
  const queryClient = useQueryClient();
  const idsKey = sessionIds.join('\n');
  const last = useRef<ReadonlyMap<string, ProjectSession>>(new Map());

  const subscribe = useCallback(
    (notify: () => void) => {
      const prefix = qk.project.sessionsScope(projectId);
      return queryClient.getQueryCache().subscribe((event) => {
        // Data changes only: observer events never change a row.
        if (event.type !== 'added' && event.type !== 'updated' && event.type !== 'removed') return;
        const key = event.query.queryKey;
        if (prefix.every((part, index) => key[index] === part)) notify();
      });
    },
    [projectId, queryClient],
  );

  const read = useCallback(() => {
    const next = readCachedWorkspaceSessions(
      queryClient,
      projectId,
      idsKey ? idsKey.split('\n') : [],
    );
    const prev = last.current;
    const same = prev.size === next.size && [...next].every(([id, row]) => prev.get(id) === row);
    if (same) return prev;
    last.current = next;
    return next;
  }, [idsKey, projectId, queryClient]);

  return useSyncExternalStore(subscribe, read, read);
}
