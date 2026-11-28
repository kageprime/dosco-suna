'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listWorkspaceAgentDirectory, setWorkspaceAgentPaused } from '../core/rest/projects-client/agent-directory';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The agents the caller can message (`channels` flag). Its key sits under the
 * spaces key, so opening an agent's chat (`useOpenWorkspaceDm`) refreshes its
 * `chat_space_id`. Pass `enabled: false` while the flag is off: the route
 * answers 403 then.
 */
export function useWorkspaceAgentDirectory(workspaceId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qk.project.agentDirectory(workspaceId ?? ''),
    queryFn: () => listWorkspaceAgentDirectory(workspaceId as string),
    enabled: !!workspaceId && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

/** Pause or resume an agent (`setWorkspaceAgentPaused`); refreshes the agent directory. */
export function useSetWorkspaceAgentPaused(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, paused }: { name: string; paused: boolean }) => setWorkspaceAgentPaused(workspaceId, name, paused),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.project.agentDirectory(workspaceId) }),
  });
}
