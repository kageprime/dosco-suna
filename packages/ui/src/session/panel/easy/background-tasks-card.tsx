'use client';

/**
 * Background tasks — the agents this session started that work beside it: its
 * subagents and, with `agent_teams`, its teammates.
 *
 * The section lists the agents still running (or waiting on you, or failed):
 * the agent's mark, its name and task, how long it has worked, and a stop
 * button. A done agent leaves the list; one last row, "N finished", opens the
 * whole set in the detail panel.
 *
 * The detail (`BackgroundTasksDetail`) reads the agents line itself, so its
 * timers tick and Stop works while it is open: a Running group, then a
 * collapsible Finished group, one card per agent. A card opens that agent's
 * session.
 *
 * The data is the composer's agents line (`useAgentsLine`): the same lists, the
 * same polling. Nothing renders while the session started no agent.
 */

import { CaretDownIcon, CaretRightIcon, SquareIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../../primitives/disclosure';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { useKortixComputerStore } from '../../../internal/stores/kortix-computer-store';
import { SolidCheckIcon } from '../../../internal/icons/solid-check-icon';
import { AgentMarkGlyph } from '../../../internal/components/agent-mark';
import { agentSlug } from '../../agents/agent-surface';
import { shortElapsed, type AgentRow } from '../../agents/agent-model';
import { useAgentsLine } from '../../agents/agent-strip';
import type { Detail } from './detail-view';
import { PANEL_ROW, PANEL_ROW_ICON, PanelCard } from './panel-card';

/** A finished agent: the agents line calls both of these "done". */
export function isFinishedAgent(row: Pick<AgentRow, 'state'>): boolean {
  return row.state === 'completed' || row.state === 'idle';
}

/** Running first (oldest start first), then the rest by newest activity. */
function splitRows(rows: AgentRow[]) {
  const finished = rows.filter(isFinishedAgent).sort((a, b) => b.activityMs - a.activityMs);
  const active = rows.filter((row) => !isFinishedAgent(row));
  return { finished, active };
}

/** Now, ticking once a second while something runs: the elapsed times read live. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
}

function elapsedOf(row: AgentRow, now: number): string | null {
  return row.state === 'working' && row.workingSinceMs !== null ? shortElapsed(now - row.workingSinceMs) : null;
}

function clockOf(ms: number): string | null {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
}

function useOpenAgent() {
  const focusAgent = useKortixComputerStore((s) => s.focusAgent);
  return (row: AgentRow) =>
    focusAgent({ sessionId: row.sessionId, title: row.handle, handle: row.handle, task: row.line ?? undefined });
}

/** The agent's pixel mark in a row's leading slot. */
function Mark({ handle }: { handle: string }) {
  return <AgentMarkGlyph slug={agentSlug(handle)} size={14} trim />;
}

/** Stop for a running agent: a filled square, a spinner while it stops. */
function StopButton({ row, stopping, onStop }: { row: AgentRow; stopping: boolean; onStop: (row: AgentRow) => void }) {
  const t = useTranslations('multiAgent.strip');
  if (stopping) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center">
        <Loading className="text-muted-foreground size-3" />
      </span>
    );
  }
  if (row.state !== 'working' && row.state !== 'needs_input') return null;
  return (
    <Hint label={t('stopHint')} side="left">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('stopAgent', { name: row.handle })}
        onClick={(event) => {
          event.stopPropagation();
          onStop(row);
        }}
        className="text-foreground shrink-0"
      >
        <SquareIcon weight="fill" className="size-3" />
      </Button>
    </Hint>
  );
}

export function BackgroundTasksCard({
  projectId,
  sessionId,
  live,
  onOpenDetail,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  /** The session works now: the lists poll every 5 s instead of every 30 s. */
  live: boolean;
  /** Opens the full list in the detail panel. */
  onOpenDetail: (detail: Detail) => void;
}) {
  const t = useTranslations('sessionUi.panel');
  const line = useAgentsLine(projectId, sessionId, { live });
  const openAgent = useOpenAgent();
  const rows = [...line.agents, ...line.team];
  const { finished, active } = splitRows(rows);
  const now = useNow(active.some((row) => row.state === 'working'));
  if (!line.ready || rows.length === 0) return null;

  const openAll = () =>
    onOpenDetail({
      key: 'background-tasks',
      title: t('backgroundTasks'),
      body: <BackgroundTasksDetail projectId={projectId} sessionId={sessionId} live={live} />,
    });

  return (
    <PanelCard title={t('backgroundTasks')} isEmpty={false}>
      <ul className="flex flex-col">
        {active.map((row) => {
          const elapsed = elapsedOf(row, now);
          return (
            <li key={row.sessionId} className="mx-1 flex items-center rounded-md transition-colors duration-(--duration-fast) hover:bg-hover">
              <button
                type="button"
                onClick={() => openAgent(row)}
                className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-3 px-2 text-left text-sm"
              >
                <span className={PANEL_ROW_ICON}>
                  <Mark handle={row.handle} />
                </span>
                <span className="text-foreground min-w-0 truncate">{row.handle}</span>
                {row.line && <span className="text-muted-foreground min-w-0 flex-1 truncate">{row.line}</span>}
                {elapsed && <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">{elapsed}</span>}
              </button>
              <span className="flex shrink-0 pr-1">
                <StopButton row={row} stopping={line.stopping.has(row.sessionId)} onStop={line.stop} />
              </span>
            </li>
          );
        })}
        {finished.length > 0 && (
          <li className="flex">
            <button type="button" onClick={openAll} className={cn(PANEL_ROW, 'text-muted-foreground hover:text-foreground cursor-pointer')}>
              <span className={PANEL_ROW_ICON}>
                <SolidCheckIcon className="size-3.5!" />
              </span>
              <span className="truncate">{t('finishedCount', { count: finished.length })}</span>
            </button>
          </li>
        )}
      </ul>
    </PanelCard>
  );
}

/**
 * Every background task of the session, live: a Running group, then a
 * collapsible Finished group. One card per agent: its mark and name (the card
 * opens it), its task below, the time on the right — elapsed while it works,
 * the clock time it finished once done — and Stop while it runs.
 */
export function BackgroundTasksDetail({
  projectId,
  sessionId,
  live,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  live: boolean;
}) {
  const t = useTranslations('sessionUi.panel');
  const line = useAgentsLine(projectId, sessionId, { live });
  const openAgent = useOpenAgent();
  const { finished, active } = splitRows([...line.agents, ...line.team]);
  const now = useNow(active.some((row) => row.state === 'working'));
  const [finishedOpen, setFinishedOpen] = useState(true);

  return (
    <div className="flex flex-col gap-6">
      {active.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-muted-foreground flex gap-1.5 px-1 text-sm">
            {t('running')}
            <span className="tabular-nums">{active.length}</span>
          </h3>
          {active.map((row) => (
            <TaskCard
              key={row.sessionId}
              row={row}
              time={elapsedOf(row, now)}
              onOpen={openAgent}
              action={<StopButton row={row} stopping={line.stopping.has(row.sessionId)} onStop={line.stop} />}
            />
          ))}
        </section>
      )}
      {finished.length > 0 && (
        <Disclosure open={finishedOpen} onOpenChange={setFinishedOpen}>
          <DisclosureTrigger>
            <div className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1.5 px-1 text-sm transition-colors">
              <CaretDownIcon className={cn('size-3.5 transition-transform motion-reduce:transition-none', !finishedOpen && '-rotate-90')} />
              {t('finished')}
              <span className="tabular-nums">{finished.length}</span>
            </div>
          </DisclosureTrigger>
          <DisclosureContent contentClassName="flex flex-col gap-2 pt-2">
            {finished.map((row) => (
              <TaskCard key={row.sessionId} row={row} time={clockOf(row.activityMs)} onOpen={openAgent} />
            ))}
          </DisclosureContent>
        </Disclosure>
      )}
    </div>
  );
}

function TaskCard({
  row,
  time,
  onOpen,
  action,
}: {
  row: AgentRow;
  time: string | null;
  onOpen: (row: AgentRow) => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-popover border-border hover:bg-hover flex items-start gap-2 rounded-md border pr-2 transition-colors duration-(--duration-fast)">
      <button type="button" onClick={() => onOpen(row)} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 py-2.5 pl-3 text-left text-sm">
        <span className="flex h-[1lh] w-4 shrink-0 items-center justify-center">
          <Mark handle={row.handle} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-foreground truncate">{row.handle}</span>
            <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0" />
          </span>
          {row.line && <span className="text-muted-foreground line-clamp-2">{row.line}</span>}
        </span>
        {time && <span className="text-muted-foreground flex h-[1lh] shrink-0 items-center text-xs tabular-nums">{time}</span>}
      </button>
      {action && <span className="mt-2.5 flex h-[1lh] shrink-0 items-center text-sm">{action}</span>}
    </div>
  );
}
