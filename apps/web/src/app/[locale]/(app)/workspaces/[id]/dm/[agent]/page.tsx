'use client';

import { notFound, useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { SpaceFileView } from '@/features/drives/space-file-view';
import { SpaceFolderView } from '@/features/drives/space-folder-view';
import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { isMyKortixAgentName } from '@kortix/shared';
import { uiRoutes } from '@kortix/ui';
import { AgentChatView } from '@kortix/ui/workspace';

/**
 * /workspaces/[id]/dm/[agent] — an agent's chat (flag `channels`): the
 * person's one chat with that agent, its DM space. Every message is a thread;
 * the agent's newest reply shows under it. My Kortix always opens the person's
 * own chat (`/chat`). Without `channels` the page does not exist.
 */
export default function ProjectDmPage() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const agentName = decodeURIComponent(agent);
  const router = useRouter();
  const channels = useFeatureFlag(id, 'channels');
  const beforeSend = useProjectSendGate(id);
  const agentChat = channels.enabled && !isMyKortixAgentName(agentName);

  useEffect(() => {
    if (channels.enabled && !agentChat) router.replace(`${uiRoutes().project(id)}/chat`);
  }, [channels.enabled, agentChat, id, router]);

  if (!channels.isLoading && !channels.enabled) notFound();
  if (!agentChat) return null;
  return (
    <AgentChatView
      projectId={id}
      agentName={agentName}
      beforeSend={beforeSend}
      renderFolder={(folder) => <SpaceFolderView projectId={id} {...folder} />}
      renderFile={(file) => <SpaceFileView projectId={id} {...file} />}
      chat
    />
  );
}
