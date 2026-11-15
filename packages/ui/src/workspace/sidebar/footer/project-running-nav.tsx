'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRightIcon, PulseIcon, SquareIcon } from '@phosphor-icons/react';
import { stopProjectSession, type ProjectSession } from '@kortix/sdk';
import { RUNNING_SESSIONS_LIMIT, qk, useNow, useRunningSessions, useWorkspaceSession } from '@kortix/sdk/react';
import { Button } from '../../../primitives/button';
import { CountBadge } from '../../../primitives/count-badge';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../../primitives/sidebar';
import { errorToast } from '../../../primitives/toast';
import { useIsMobile } from '../../../internal/hooks';
import { useTranslations } from '../../../i18n';
import { uiRoutes } from '../../../lib/routes';
import { useUiRouter } from '../../../providers/ui-provider';
import { AgentStateMark } from '../../../session/agents/agent-state-mark';
import { getSessionDisplayTitle } from '../../../session/actions/project-session-list-helpers';
import { formatElapsed } from '../../../session/tool/tools/workflow-run';

/**
 * The workspace's Running row (dev audit finding 19): one place that answers
 * "what is still running?" without opening each session. The row always sits
 * in the nav, so the session list below never jumps when a run starts or ends;
 * its count shows while something works. It opens a list of every session at
 * work now (`working=only`): workflow runners, their agents, colleagues and any
 * other session with a live turn. Each row says where it runs, its state and
 * for how long, and offers Open and Stop (the session's own Stop).
 *
 * The read polls every 20 s while nothing runs, every 15 s while something
 * does, and every 5 s while the list is open (`useRunningSessions`).
 */
export function ProjectRunningNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const [open, setOpen] = useState(false);
  const running = useRunningSessions(projectId, { open });
  const sessions = running.data ?? [];
  const label = t('running');
  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton isActive={open} className="text-sidebar-foreground" data-testid="sidebar-running">
            <span className="shrink-0">
              <PulseIcon />
            </span>
            <span className="truncate">{label}</span>
            {sessions.length > 0 && (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <CountBadge count={sessions.length} aria-label={t('runningCount', { count: sessions.length })} />
              </span>
            )}
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={8}
          aria-label={t('runningTitle')}
          data-testid="sidebar-running-panel"
          tabIndex={-1}
          // Focus the panel, not its first row action, so Escape closes the panel.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          className="flex w-[min(380px,calc(100vw-1.5rem))] flex-col p-0"
        >
          <RunningPanel
            projectId={projectId}
            sessions={sessions}
            // "Nothing is running" only after a read answered: not while it loads, not when it failed.
            state={runningPanelState(running)}
            onRetry={() => void running.refetch()}
            onNavigate={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

/**
 * What an empty list means. A failed read wins over cached data: after an
 * empty answer, a failed refresh keeps `[]`, which is not "nothing runs".
 */
export function runningPanelState(query: { data?: unknown; isError: boolean; isFetching?: boolean }): 'loading' | 'error' | 'ready' {
  // A retry after an error reads as loading, so "Try again" shows it works.
  if (query.isError) return query.isFetching ? 'loading' : 'error';
  return query.data ? 'ready' : 'loading';
}

export function RunningPanel({
  projectId,
  sessions,
  state = 'ready',
  onRetry,
  onNavigate,
}: {
  projectId: string;
  sessions: ProjectSession[];
  /** The read behind `sessions`: an empty list means "nothing runs" only when `ready`. */
  state?: 'loading' | 'error' | 'ready';
  onRetry?: () => void;
  onNavigate: () => void;
}) {
  const t = useTranslations('sidebar');
  const tStrip = useTranslations('multiAgent.strip');
  const queryClient = useQueryClient();
  const now = useNow(1_000);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const stop = useMutation({
    mutationFn: (session: ProjectSession) => stopProjectSession(projectId, session.session_id),
    onMutate: (session) => setStopping((previous) => new Set(previous).add(session.session_id)),
    onSettled: (_data, _error, session) => {
      setStopping((previous) => {
        const next = new Set(previous);
        next.delete(session.session_id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    },
    onError: (error, session) =>
      errorToast(tStrip('stopAgentFailed', { name: getSessionDisplayTitle(session) }), {
        description: error instanceof Error ? error.message : undefined,
      }),
  });
  // Oldest first: the longest-running work is the likeliest to be forgotten.
  const rows = [...sessions].sort((a, b) => sinceMs(a) - sinceMs(b));
  return (
    <div className="flex min-w-0 flex-col">
      <header className="border-border text-foreground border-b px-3 py-2 text-xs font-medium">{t('runningTitle')}</header>
      {rows.length === 0 && state === 'loading' ? (
        <div className="flex justify-center px-3 py-3" role="status" aria-label={t('runningTitle')}>
          <Loading className="text-muted-foreground size-3" />
        </div>
      ) : rows.length === 0 && state === 'error' ? (
        <div className="text-muted-foreground flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <span>{t('runningFailed')}</span>
          {onRetry && (
            <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
              {t('runningRetry')}
            </Button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">{t('runningEmpty')}</p>
      ) : (
        <ul className="flex max-h-96 min-w-0 flex-col overflow-y-auto p-1">
          {rows.map((session) => (
            <RunningRow
              key={session.session_id}
              projectId={projectId}
              session={session}
              now={now}
              stopping={stopping.has(session.session_id)}
              onStop={() => stop.mutate(session)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {rows.length >= RUNNING_SESSIONS_LIMIT && (
        <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
          {t('runningFirst', { count: RUNNING_SESSIONS_LIMIT })}
        </p>
      )}
    </div>
  );
}

/** When the session's live turn started, epoch ms; NaN sorts last. */
function sinceMs(session: ProjectSession): number {
  const since = session.working?.state === 'working' ? session.working.since : null;
  const at = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
}

const ROW_ACTIONS =
  'flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

function RunningRow({
  projectId,
  session,
  now,
  stopping,
  onStop,
  onNavigate,
}: {
  projectId: string;
  session: ProjectSession;
  now: number;
  stopping: boolean;
  onStop: () => void;
  onNavigate: () => void;
}) {
  const t = useTranslations('sidebar');
  const tStrip = useTranslations('multiAgent.strip');
  const router = useUiRouter();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const parentId = session.parent_session_id ?? null;
  // The session it runs under: a workflow runner's caller, an agent's runner.
  const parent = useWorkspaceSession(projectId, parentId ?? undefined, { enabled: !!parentId });
  const title = getSessionDisplayTitle(session);
  const needsYou = session.board_state === 'needs_input';
  const started = sinceMs(session);
  const elapsed = started < Number.MAX_SAFE_INTEGER ? formatElapsed(Math.max(0, now - started)) : null;
  const state = needsYou ? tStrip('state.needs_input') : elapsed ? tStrip('workingFor', { elapsed }) : tStrip('state.working');
  const openSession = () => {
    onNavigate();
    if (isMobile) setOpenMobile(false);
    router.push(uiRoutes().session(projectId, session.session_id));
  };
  return (
    <li
      data-testid="sidebar-running-row"
      data-session-id={session.session_id}
      className="group/row hover:bg-hover focus-within:bg-hover flex min-w-0 items-center gap-1 rounded-sm"
    >
      <div onClick={openSession} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2 text-xs">
        <AgentStateMark state={needsYou ? 'needs_input' : 'working'} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-foreground min-w-0 truncate font-medium">{title}</span>
            <span className="text-muted-foreground ml-auto shrink-0 tabular-nums">{state}</span>
          </div>
          {parentId && parent.data && (
            <p className="text-muted-foreground truncate">{t('runningIn', { title: getSessionDisplayTitle(parent.data) })}</p>
          )}
        </div>
      </div>
      <div className={`${ROW_ACTIONS} pr-1${stopping ? ' opacity-100' : ''}`}>
        <Hint label={tStrip('openAgent', { name: title })} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tStrip('openAgent', { name: title })}
            onClick={openSession}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
        {stopping ? (
          <span className="flex size-6 items-center justify-center">
            <Loading className="text-muted-foreground size-3" />
          </span>
        ) : session.can_manage_lifecycle !== false ? (
          <Hint label={tStrip('stopAgent', { name: title })} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={tStrip('stopAgent', { name: title })}
              onClick={onStop}
              className="text-muted-foreground hover:text-foreground"
            >
              <SquareIcon weight="fill" className="size-2.5" />
            </Button>
          </Hint>
        ) : null}
      </div>
    </li>
  );
}
