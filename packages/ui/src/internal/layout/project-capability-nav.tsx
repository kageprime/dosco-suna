'use client';

import { adminPath } from '../../lib/routes';

import { useProjectConfig } from '@kortix/sdk/react';

import { CaretRightIcon, CpuIcon, GearSixIcon, ListIcon, RobotIcon, TrayIcon } from '@phosphor-icons/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../components/agent-mark';
import { CountBadge } from '../../primitives/count-badge';
import { cn } from '../../lib/utils';
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname, useUiSearchParams } from '../../providers/ui-provider';
import { useIsMobile } from '../hooks';
import { activeCapabilityTab, agentHref, capabilityTabHref } from '../lib/capability-tab-routes';
import { useReviewSessionSummary } from '../hooks/use-review-session-summary';
import { usePinnedAgents } from '../stores/pinned-agents-store';
import { useCapabilityAccess } from './project-settings-nav';

/** Customize lists this many agents when none is pinned; All agents holds the rest. */
const SIDEBAR_AGENT_LIMIT = 5;

type Agent = NonNullable<ReturnType<typeof useProjectConfig>>['agents'][number];

export const NewAgentContext = createContext<(() => void) | null>(null);

/** Opens the New agent modal mounted beside the sidebar; null outside `NewAgentModalProvider`. */
export function useOpenNewAgent(): (() => void) | null {
  return useContext(NewAgentContext);
}

/** Every agent by display name, hidden agents last. */
export function sortCustomizeAgents<T extends Pick<Agent, 'name'> & { hidden?: boolean | null }>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) => {
    const hidden = Number(a.hidden === true) - Number(b.hidden === true);
    return hidden || agentDisplayName(a.name).localeCompare(agentDisplayName(b.name));
  });
}

/** Whether the pathname is a Project admin (Settings) page. The locale prefix
 *  the host may not strip is tolerated. */
export function isProjectAdminPath(pathname: string | null | undefined): boolean {
  return (
    !!pathname &&
    (/\/projects\/[^/]+\/admin(?:[/?#]|$)/.test(pathname) ||
      /\/projects\/[^/]+\/settings(?:[/?#]|$)/.test(pathname))
  );
}

/** A row's glyph in a 20px box (literal px, as the sidebar's agent marks), so
 *  every label starts on one column. */
function RowGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="text-muted-foreground flex shrink-0 items-center justify-center"
      style={{ width: 20, height: 20 }}
    >
      {children}
    </span>
  );
}

/**
 * What Customize opens to, kept short on purpose: most configuration happens
 * by asking an agent in a session, so the sidebar lists only the agents you
 * pinned (none pinned: the first five) and All agents when more exist, then Review (with its "needs you" count), Models, and Settings
 * (Project admin, whose top bar holds every library and Members).
 * The header's + and All agents buttons sit on the Customize row itself.
 */
export function ProjectCapabilityNav({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const config = useProjectConfig(projectId);
  const access = useCapabilityAccess(projectId);
  const needsYou = useReviewSessionSummary(projectId, { enabled: true }).totalNeedsYou;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const tTabs = useI18nTranslations('agentEditor.tabs');
  const pinned = usePinnedAgents(projectId);

  if (!access.settled) return null;

  const rawAgents = tTabs('agents');
  const agentsLabel = !rawAgents || rawAgents === 'agentEditor.tabs.agents' ? 'Agents' : rawAgents;

  const allAgents = access.tabs.includes('agent')
    ? sortCustomizeAgents((config?.agents ?? []).filter((agent) => !agent.platform))
    : [];
  // The agents you pinned, in pin order; none pinned, the first few. A
  // project with a hundred agents keeps a short sidebar either way.
  const pinnedAgents = pinned.flatMap((name) => allAgents.filter((agent) => agent.name === name));
  const agents = pinnedAgents.length > 0 ? pinnedAgents : allAgents.slice(0, SIDEBAR_AGENT_LIMIT);
  const moreAgents = allAgents.length > agents.length;
  const showReview = access.tabs.includes('review');
  const onReview = pathname ? activeCapabilityTab(pathname) === 'review' : false;
  const hasModels = access.tabs.includes('models');
  const onSettingsPage = isProjectAdminPath(pathname);
  const onModels =
    (!!pathname && /\/admin\/models(\/|$)/.test(pathname)) ||
    (onSettingsPage && searchParams.get('tab') === 'models');
  const hasSettings = access.tabs.includes('config');
  const onAgents =
    !!pathname &&
    (pathname.includes('/customize/agents') ||
      agents.some((agent) => {
        const href = agentHref(projectId, agent.name);
        return pathname === href || pathname.startsWith(`${href}/`);
      }));

  const [agentsOpen, setAgentsOpen] = useState(onAgents);

  useEffect(() => {
    if (onAgents) setAgentsOpen(true);
  }, [onAgents]);

  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  const hasAgents = allAgents.length > 0;
  if (!hasAgents && !showReview && !hasModels && !hasSettings) return null;

  // `mr-0 pr-0`: the rows reach the sidebar's right edge like the rows above;
  // the left indent and guide line stay.
  return (
    <SidebarMenuSub className="mr-0 pr-0">
      {hasAgents ? (
        <>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton asChild isActive={onAgents && !agents.some((a) => pathname === agentHref(projectId, a.name))}>
              <Link href={capabilityTabHref(projectId, 'agent')} prefetch={false} onClick={close}>
                <RowGlyph>
                  <RobotIcon className="size-3.5" />
                </RowGlyph>
                <span className="truncate">{agentsLabel}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums pr-5">
                  {allAgents.length}
                </span>
              </Link>
            </SidebarMenuSubButton>
            <button
              type="button"
              aria-label={agentsOpen ? 'Collapse agents' : 'Expand agents'}
              aria-expanded={agentsOpen}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setAgentsOpen((prev) => !prev);
              }}
              className="text-muted-foreground hover:text-sidebar-foreground absolute right-1.5 top-1/2 -translate-y-1/2 p-1 cursor-pointer transition-transform"
            >
              <CaretRightIcon
                className={cn('size-3 transition-transform duration-200', agentsOpen && 'rotate-90')}
              />
            </button>
          </SidebarMenuSubItem>

          {agentsOpen ? (
            <SidebarMenuSub className="mr-0 pr-0 my-0.5">
              {agents.map((agent) => {
                const href = agentHref(projectId, agent.name);
                const active = !!pathname && (pathname === href || pathname.startsWith(`${href}/`));
                return (
                  <SidebarMenuSubItem key={agent.name}>
                    <SidebarMenuSubButton asChild isActive={active}>
                      <Link href={href} prefetch={false} onClick={close}>
                        <RowGlyph>
                          <AgentMark slug={agent.name} size={14} />
                        </RowGlyph>
                        <span className={cn('truncate', agent.hidden && 'text-muted-foreground')}>
                          {agentDisplayName(agent.name)}
                        </span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
              {moreAgents ? (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild isActive={!!pathname && pathname.endsWith('/customize/agents')}>
                    <Link href={capabilityTabHref(projectId, 'agent')} prefetch={false} onClick={close}>
                      <RowGlyph>
                        <ListIcon className="size-3.5" />
                      </RowGlyph>
                      <span className="truncate">{tTabs('allAgents')}</span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">{allAgents.length}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ) : null}
            </SidebarMenuSub>
          ) : null}
        </>
      ) : null}

      {hasAgents && (showReview || hasModels || hasSettings) ? (
        <div className="my-1 border-t border-sidebar-border/50" />
      ) : null}

      {showReview ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onReview}>
            <Link href={capabilityTabHref(projectId, 'review')} prefetch={false} onClick={close}>
              <RowGlyph>
                <TrayIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('review')}</span>
              {needsYou > 0 ? (
                <span className="ml-auto flex shrink-0 items-center">
                  <CountBadge count={needsYou} tone="waiting" />
                </span>
              ) : null}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasModels ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onModels}>
            <Link href={`/projects/${projectId}/settings?tab=models&category=capabilities`} prefetch={false} onClick={close}>
              <RowGlyph>
                <CpuIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('models')}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {hasSettings ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton asChild isActive={onSettingsPage && !onModels}>
            <Link href={`/projects/${projectId}/settings`} prefetch={false} onClick={close}>
              <RowGlyph>
                <GearSixIcon className="size-3.5" />
              </RowGlyph>
              <span className="truncate">{tTabs('settings')}</span>
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
}
