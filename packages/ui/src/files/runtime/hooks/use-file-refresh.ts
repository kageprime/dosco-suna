'use client';

import { binaryBlobKeys, fileContentKeys, useRuntimeStore } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { clearMissingFileReadsUnder } from '../../../internal/files/file-read-retry';

/**
 * The viewer's manual Refresh — the safety net under the automatic one.
 *
 * The agent's turn end already refetches every open file (the SDK invalidates
 * the workspace file caches). This covers what that cannot see: an edit made
 * from a terminal or another tab, or a page whose CSS changed while its HTML
 * did not. It re-reads this one file's text and bytes, and bumps `reloadKey`
 * so renderers that read their own bytes (xlsx, sqlite, the HTML frame)
 * remount — a user who pressed Refresh asked for a reload, even of bytes that
 * look the same.
 *
 * Refresh always reads. The missing-file gate answers a refetch of a fresh
 * 404 without a request, so the mark clears first: a file created from a
 * terminal after a 404 shows on the next Refresh (P-F08).
 */
export function useFileRefresh(filePath: string | null | undefined) {
  const queryClient = useQueryClient();
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => {
    if (!filePath) return;
    setRefreshing(true);
    setReloadKey((n) => n + 1);
    clearMissingFileReadsUnder(serverUrl, filePath);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: fileContentKeys.file(serverUrl, filePath) }),
      queryClient.invalidateQueries({ queryKey: binaryBlobKeys.file(serverUrl, filePath) }),
    ]).finally(() => setRefreshing(false));
  }, [filePath, queryClient, serverUrl]);

  return { refresh, refreshing, reloadKey };
}
