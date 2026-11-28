'use client';

import { useSetWorkspaceAgentPaused, useWorkspaceAgentDirectory } from '@kortix/sdk/react';
import { GearSixIcon, PauseCircleIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { errorToast } from '../../primitives/toast';
import { AgentSettingsTabs } from './agent-settings-tabs';
import { SpaceView, type SpaceViewProps } from './space-view';

/**
 * An agent's chat (flag `channels`): the person's DM space with the agent.
 * The gear at the right of the header opens the details panel, where the
 * agent's settings sit in tabs under its name. While the agent
 * is paused, a bar with Resume takes the composer's place: messages would wait
 * for an agent that starts nothing on its own.
 */
export function AgentChatView({ agentName, ...props }: Omit<SpaceViewProps, 'target' | 'composer' | 'headerActions' | 'detailsBody'> & { agentName: string }) {
  const t = useTranslations('spaces.agentChat.settings');
  const directory = useWorkspaceAgentDirectory(props.projectId);
  const agent = directory.data?.find((candidate) => candidate.name === agentName);
  return (
    <SpaceView
      {...props}
      target={{ kind: 'dm', agentName }}
      composer={agent?.status === 'paused' ? <AgentPausedBar projectId={props.projectId} name={agent.name} label={agent.display_name} /> : undefined}
      headerActions={
        agent
          ? (details) => (
              <Button variant="ghost" size="icon-base" aria-label={t('settingsButton')} aria-expanded={details.open} onClick={details.toggle}>
                <GearSixIcon />
              </Button>
            )
          : null
      }
      detailsBody={agent ? (space) => <AgentSettingsTabs projectId={props.projectId} agent={agent} spaceId={space.space_id} /> : undefined}
    />
  );
}

/** "Marketing is paused." and Resume, where the composer was. */
function AgentPausedBar({ projectId, name, label }: { projectId: string; name: string; label: string }) {
  const t = useTranslations('spaces.agentChat');
  const resume = useSetWorkspaceAgentPaused(projectId);
  return (
    <div data-agent-paused="" className="shrink-0 px-5 pt-1 pb-4">
      <div className="border-border bg-muted/40 flex items-center gap-3 rounded-lg border px-3 py-2.5">
        <PauseCircleIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <p className="text-muted-foreground min-w-0 flex-1 text-sm">{t('pausedBar', { name: label })}</p>
        <Button
          size="sm"
          disabled={resume.isPending}
          onClick={() =>
            resume.mutate({ name, paused: false }, { onError: () => errorToast(t('resumeFailed', { name: label })) })
          }
        >
          {t('resume')}
        </Button>
      </div>
    </div>
  );
}
