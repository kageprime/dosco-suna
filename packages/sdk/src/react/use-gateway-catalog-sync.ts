'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listWorkspaceSecrets } from '../core/rest/projects-client';
import { refreshWorkspaceProviderState } from './provider-refresh';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const REFETCH_DELAYS_MS = [0, 1200, 3000, 6000];

const CONFIG_CONTRACT = contract('config');

/**
 * The contract's error fail-safe, minus permission denials (KRTX-4636).
 *
 * `project.secret.read` is manager-tier, so a plain member legitimately 403s
 * this entry (see `listWorkspaceSecrets`), and this hook mounts it for the
 * whole project shell. Nothing here changes the member's role, so the
 * fail-safe re-asked the denial every 30 s for the life of the tab (prod:
 * 42 warns in 20 minutes). A denial stands down like a 404; every other
 * error keeps the fail-safe.
 */
function secretsRefetchInterval(query: {
  state: { status: string; data?: unknown; error?: unknown; errorUpdateCount: number };
}): number | false {
  const status = (query.state.error as { status?: number } | null | undefined)?.status;
  if (status === 403) return false;
  const failSafe = CONFIG_CONTRACT.refetchInterval;
  return typeof failSafe === 'function' ? failSafe(query) : failSafe;
}

export function useGatewayCatalogSync(projectId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);

  const secretsQuery = useQuery({
    // Same entry every other `listProjectSecrets` reader shares.
    queryKey: qk.project.secrets(projectId ?? ''),
    queryFn: () => listWorkspaceSecrets(projectId as string),
    enabled: !!projectId && runtimeReady,
    ...CONFIG_CONTRACT,
    refetchInterval: secretsRefetchInterval,
  });

  const signature = (() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return items.map((item) => item.name).sort().join(',');
  })();

  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || secretsQuery.data === undefined) return;
    if (previous.current === null) {
      previous.current = signature;
      return;
    }
    if (previous.current === signature) return;
    previous.current = signature;

    const timers = REFETCH_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        refreshWorkspaceProviderState(queryClient, projectId);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [projectId, signature, secretsQuery.data, queryClient]);
}
