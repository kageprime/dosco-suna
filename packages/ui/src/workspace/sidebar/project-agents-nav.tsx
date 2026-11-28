'use client';

import type { WorkspaceAgentEntry } from '@kortix/sdk';
import { useNotificationInbox, useProjectSessions, useWorkspaceAgentDirectory } from '@kortix/sdk/react';
import { PauseCircleIcon, PlusIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { useIsMobile } from '../../internal/hooks';
import { useComposerPrefillStore } from '../../internal/stores/composer-prefill-store';
import { useUiRouter, useUiViewerId } from '../../providers/ui-provider';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';

/** `href`, or a page under it. */
function isAt(pathname: string | null, href: string): boolean {
  return !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * The Agents rows of the sidebar (flag `channels`): one row per agent the
 * person can message, after their own space. My Kortix is that space, so it
 * is not repeated here. A row opens the agent's chat (`/dm/<agent>`). New
 * agent opens the chat with My Kortix with the request in the composer. Rows
 * render once the list arrives; nothing renders while the flag is off.
 */
export function ProjectAgentsRows({
  projectId,
  pathname,
  enabled,
}: {
  projectId: string;
  pathname: string | null;
  enabled: boolean;
}) {
  const t = useTranslations('sidebar.agents');
  const directory = useWorkspaceAgentDirectory(projectId, { enabled });
  const router = useUiRouter();
  const setPrefill = useComposerPrefillStore((s) => s.setPrefill);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const shown = (directory.data ?? []).filter((entry) => !entry.builtin);
  if (!enabled || !directory.data) return null;
  // A new agent is made in the person's chat with My Kortix: the request waits in the composer, unsent, to edit first.
  const newAgent = () => {
    setPrefill(projectId, t('newAgentPrompt'));
    if (isMobile) setOpenMobile(false);
    router.push(`${uiRoutes().project(projectId)}/chat`);
  };
  return (
    <>
      <ChatSectionHeading label={t('title')} actionLabel={t('newAgent')} onAction={newAgent} />
      {shown.map((entry) => {
        const href = uiRoutes().dm(projectId, entry.name);
        return <AgentRow key={entry.name} projectId={projectId} agent={entry} href={href} active={isAt(pathname, href)} />;
      })}
    </>
  );
}

/**
 * A section heading of the chat sidebar (Agents, Channels): its name, and at
 * the row's right edge a + that adds one (New agent, New channel).
 */
export function ChatSectionHeading({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <li className="text-muted-foreground flex items-center justify-between gap-1 pt-3 pr-1 pb-1 pl-2 text-xs">
      <span className="truncate">{label}</span>
      <Hint label={actionLabel} side="top">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={actionLabel}
          onClick={onAction}
          className="text-muted-foreground hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </Hint>
    </li>
  );
}

/**
 * One agent: its pixel mark and its name on one line, a pause icon when it is
 * paused, and at the row's right edge a dot when its chat has an update.
 */
function AgentRow({
  projectId,
  agent,
  href,
  active,
}: {
  projectId: string;
  agent: WorkspaceAgentEntry;
  href: string;
  active: boolean;
}) {
  const t = useTranslations('sidebar.agents');
  const tn = useTranslations('notifications');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // The chat's thread list: the same cache entry the agent's chat reads.
  const threads = useProjectSessions(projectId, { spaceId: agent.chat_space_id ?? undefined, parent: 'root', enabled: !!agent.chat_space_id });
  // The inbox's own cache entry (the bell reads it too): an unread row on one of this chat's threads is an update.
  const viewerId = useUiViewerId();
  const inbox = useNotificationInbox({ userId: viewerId, enabled: !!viewerId && !!agent.chat_space_id });
  const hasUpdate = useMemo(() => {
    const ids = new Set((threads.sessions ?? []).map((session) => session.session_id));
    return (inbox.data?.notifications ?? []).some((row) => !row.read && !!row.session_id && ids.has(row.session_id));
  }, [threads.sessions, inbox.data]);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={agent.display_name}
        className="text-sidebar-foreground gap-2 px-2 [&_[data-slot=agent-mark]>svg]:size-auto! [&_[data-slot=agent-paused]]:size-3!"
      >
        <HoverPrefetchLink
          href={href}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <AgentMark slug={agent.name} size={14} label={agent.display_name} />
          <span className="truncate">{agent.display_name}</span>
          {agent.status === 'paused' ? (
            <PauseCircleIcon data-slot="agent-paused" role="img" aria-label={t('paused')} className="text-muted-foreground shrink-0" />
          ) : null}
          {/* A fixed lane at the row's right edge, so names align whether or not a row has an update. */}
          <span className="ml-auto flex w-2 shrink-0 items-center justify-end pr-0.5">
            {hasUpdate ? (
              <>
                <span aria-hidden className="bg-kortix-blue size-1.5 rounded-full" />
                <span className="sr-only">{tn('inbox.unread')}</span>
              </>
            ) : null}
          </span>
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
