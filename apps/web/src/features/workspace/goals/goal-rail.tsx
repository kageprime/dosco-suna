'use client';

import { AgentMark } from '@kortix/ui/internal/components/agent-mark';
import { uiRoutes } from '@kortix/ui';
import {
  formatGoalTime,
  goalCriteriaStatus,
  goalIconState,
  goalLastWake,
  goalNextWake,
  goalPaused,
  GoalPersonChip,
  GoalStatusIcon,
  useGoalClock,
  useGoalPerson,
} from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectGoal } from '@kortix/sdk';
import { useProjectSession } from '@kortix/sdk/react';
import {
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  FolderOpenIcon,
  HourglassIcon,
  LightningIcon,
  LockSimpleIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useAuth } from '@/features/providers/auth-provider';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { RobotlessIcon, SectionTitle, text } from './goal-parts';

/** The goal page's properties rail: state, agent, checks, wakes, sessions, visibility and folder. */


/**
 * The properties rail: one quiet row per property, its glyph and its value:
 * state, agent, the next and last check, wakes today against the cap, who it
 * waits on, the person it is for, who can see it. Then its sessions against
 * the cap and its folder. Sticky beside the main column; under it on a narrow container.
 */
function GoalRail({ projectId, goal, onShare }: { projectId: string; goal: ProjectGoal; onShare: () => void }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const personOf = useGoalPerson(projectId);
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const next = open && !paused ? goalNextWake(goal) : null;
  const lastWake = goalLastWake(goal);
  const counts = goalCriteriaStatus(goal);
  const driveHref = uiRoutes().drive(projectId);
  const folderHref = driveHref ? `${driveHref}?path=${encodeURIComponent(goal.folder)}` : null;
  const agent = text(record.agent);
  const { user } = useAuth();
  const stateLabel = paused ? t('paused') : t(`status.${record.state}`);
  const nextLabel = next
    ? waiting
      ? t('chaseAt', { time: formatGoalTime(next, locale, now) })
      : t('nextCheckAt', { time: formatGoalTime(next, locale, now) })
    : waiting
      ? t('waitNoCost')
      : t('noCheck');
  const atCap = record.wakes_today >= record.max_wakes_per_day;

  return (
    <aside className="flex min-w-0 flex-col gap-7 self-start @4xl/goal:sticky @4xl/goal:top-10" aria-label={t('properties')} data-testid="goal-properties">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('properties')}</SectionTitle>
        <ul className="flex flex-col text-sm">
          <Property icon={<GoalStatusIcon state={goalIconState(goal)} progress={counts.total ? counts.met / counts.total : 0} />}>{stateLabel}</Property>
          <Property icon={agent ? <AgentMark slug={agent} size={14} tile={16} className="ring-0" /> : <RobotlessIcon />} muted={!agent}>
            {agent ?? t('noAgent')}
          </Property>
          {waiting ? (
            <Property icon={<HourglassIcon className="size-4" aria-hidden />}>
              {t('waitingOnPerson', { person: personOf(record.assigned_user_id ?? record.created_by_user_id) ?? t('anotherMember') })}
            </Property>
          ) : null}
          {open ? (
            // Wakes and checks belong to an open goal; a done or stopped one has none to show.
            <>
            <Property icon={<ClockIcon className="size-4" aria-hidden />} muted={!next}>
              {nextLabel}
            </Property>
            <Property icon={<ClockCounterClockwiseIcon className="size-4" aria-hidden />} muted={!lastWake}>
              {lastWake ? t('lastCheckAt', { time: formatGoalTime(lastWake, locale, now) }) : t('neverChecked')}
            </Property>
            <Property icon={<LightningIcon className="size-4" aria-hidden />} muted={!atCap}>
              <span data-testid="goal-wakes-today">{t('wakesTodayCount', { count: record.wakes_today, max: record.max_wakes_per_day })}</span>
            </Property>
            </>
          ) : null}
          {record.assigned_user_id && user && record.assigned_user_id !== user.id ? (
            // Who it is for, only when that is someone else: "you" says nothing.
            <li className="flex h-8 min-w-0 items-center">
              <GoalPersonChip projectId={projectId} userId={record.assigned_user_id} />
            </li>
          ) : null}
          <li>
            {/* Who can see it: a ghost button that opens the share dialog. */}
            <button
              type="button"
              onClick={onShare}
              className="hover:bg-hover text-foreground focus-visible:ring-ring -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-2"
              aria-haspopup="dialog"
              aria-label={t('shareVisibility', { scope: t(`scope.${goal.scope}`) })}
              data-testid="goal-visibility"
            >
              <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">
                {goal.scope === 'personal' ? <LockSimpleIcon className="size-4" aria-hidden /> : <UsersIcon className="size-4" aria-hidden />}
              </span>
              <span className="min-w-0 truncate">{t(`scope.${goal.scope}`)}</span>
            </button>
          </li>
        </ul>
      </div>

      {record.sessions.length ? (
        <div className="flex flex-col gap-1">
          <SectionTitle aside={<span className="text-muted-foreground text-sm tabular-nums">{t('ofMax', { count: record.sessions.length, max: record.max_sessions })}</span>}>
            {t('sessions')}
          </SectionTitle>
          <ul className="flex flex-col text-sm">
            {record.sessions.map((s) => (
              <li key={`${s.role}:${s.id}`}>
                <Link
                  href={uiRoutes().session(projectId, s.id)}
                  className="hover:bg-hover focus-visible:ring-ring -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 outline-none focus-visible:ring-2"
                >
                  <ChatCircleIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="text-foreground min-w-0 truncate">
                    <SessionName projectId={projectId} sessionId={s.id} />
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">{t(`role.${s.role}`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {folderHref ? (
        <div className="flex flex-col gap-1">
          <SectionTitle>{t('filesLabel')}</SectionTitle>
          <Link href={folderHref} className="hover:bg-hover text-foreground focus-visible:ring-ring -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2">
            <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
            {t('openFolder')}
          </Link>
        </div>
      ) : null}
    </aside>
  );
}

/** A glyph-first property row: the glyph in a fixed 16 px slot, then the value. */
function Property({ icon, children, muted }: { icon: ReactNode; children: ReactNode; muted?: boolean }) {
  return (
    <li className="flex h-8 min-w-0 items-center gap-2">
      <span className="text-muted-foreground flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={muted ? 'text-muted-foreground min-w-0 truncate' : 'text-foreground min-w-0 truncate'}>{children}</span>
    </li>
  );
}

/** A session's display name, or its id until the row loads (or when it is gone). */
function SessionName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useProjectSession(projectId, sessionId);
  return <>{session.data?.name || sessionId}</>;
}

export { GoalRail };
