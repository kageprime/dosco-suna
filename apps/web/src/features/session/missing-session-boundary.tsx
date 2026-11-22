'use client';

import { ApiError, isSessionFresh, isSessionStartError, sessionStartKey } from '@kortix/sdk';
import { useWorkspaceSession } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

/**
 * The route owns the lifetime of every session-specific reader.
 *
 * An existing session's readers (`/start`, presence, the event streams, the
 * log, the turn, the panels) mount only once its row answered. A row that
 * answers 404 renders `fallback`, so a wrong or stale link sends no `/start`
 * and opens no subscription. The row read rides the session-open bundle the
 * access boundary already started, and the sidebar caches the row, so an
 * existing session waits on no extra request.
 */
export function MissingSessionBoundary({
  projectId,
  sessionId,
  children,
  fallback,
  pending,
}: {
  projectId: string;
  sessionId: string;
  children: ReactNode;
  fallback: ReactNode;
  /** Painted while an existing session's row is read for the first time. */
  pending: ReactNode;
}) {
  // A session this tab just created can 404 until its create lands; its
  // `/start` retries own that race. Read at mount: the page clears the mark.
  const [fresh] = useState(() => isSessionFresh(sessionId));
  const row = useWorkspaceSession(projectId, sessionId, { enabled: !fresh });
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => null,
    enabled: false,
  });
  // A fresh session's create/start race still retries: Query only publishes an
  // error after those retries finish. Cached session data is not a missing row.
  const startMissing =
    start.isError && isSessionStartError(start.error) && start.error.status === 404 && !start.data;
  const rowMissing = !fresh && row.error instanceof ApiError && row.error.status === 404;
  if (startMissing || rowMissing) return fallback;
  // Any other failure (5xx, network) mounts the session on its first try: the
  // page has its own error states, and a retrying row must not hold it.
  if (!fresh && row.isPending && row.failureCount === 0) return pending;
  return children;
}
