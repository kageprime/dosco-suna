'use client';

import { getSlackInstallation, listConnectors, listProjectSecrets } from '@kortix/sdk';
import { contract, FRESHNESS, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { buildRows } from '../../customize/sections/view/secrets-view';
import { useTranslations } from '../../i18n';
import { setupSteps, slackNeeded, type SetupStep } from './setup-steps';

/**
 * A workspace's setup steps, read from the cache entries the Customize pages
 * and the project shell's prefetch already fill. The setup page polls them
 * (`pollMs`): the person may finish a step in another tab. The home banner
 * reads them as they are.
 */
export function useSetupSteps(
  projectId: string,
  { slackRequested = false, pollMs, enabled = true }: { slackRequested?: boolean; pollMs?: number; enabled?: boolean } = {},
): { steps: SetupStep[]; usesSlack: boolean; loading: boolean; failed: boolean; refresh: () => void } {
  const t = useTranslations('workspaceSetup');
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
    enabled,
  });
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
    refetchOnWindowFocus: true,
    refetchInterval: pollMs ?? false,
    enabled,
  });
  const connectors = connectorsQuery.data?.connectors ?? [];
  const usesSlack = slackNeeded(connectors, slackRequested);
  // The same cache entry as the Channels page (`useSlackInstall`).
  const slackInstallQuery = useQuery({
    queryKey: ['channels', 'slack-install', projectId],
    queryFn: () => getSlackInstallation(projectId),
    enabled: enabled && usesSlack,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (pollMs && !query.state.data ? pollMs : false),
  });

  const loading = connectorsQuery.isLoading || secretsQuery.isLoading || (usesSlack && slackInstallQuery.isLoading);
  const failed = connectorsQuery.isError || secretsQuery.isError;
  const steps =
    !enabled || loading || failed
      ? []
      : setupSteps({
          connectors,
          secrets: buildRows(secretsQuery.data),
          slack: { needed: usesSlack, installed: Boolean(slackInstallQuery.data) },
          slackName: t('slackName'),
        });
  const refresh = () => {
    void connectorsQuery.refetch();
    void secretsQuery.refetch();
    if (usesSlack) void slackInstallQuery.refetch();
  };
  return { steps, usesSlack, loading, failed, refresh };
}
