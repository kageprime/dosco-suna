'use client';

import { Button } from '@kortix/ui/button';
import { Alert as BannerAlert, AlertTitle as BannerAlertTitle, AlertDescription as BannerAlertDescription, AlertActions as BannerAlertActions, AlertMedia as BannerAlertMedia } from '@kortix/ui/alert';
import { ErrorState } from '@kortix/ui/error-state';
import { Hint } from '@kortix/ui/hint';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { uiRoutes } from '@kortix/ui';
import {
  goalCriteriaStatus,
  goalHref,
  goalIconState,
  goalPaused,
  GoalStatusIcon,
  useGoalBlockedNextStep,
  useGoalIssueText,
  useGoalPerson,
} from '@kortix/ui/workspace';
import { useTranslations } from '@/i18n/use-translations';
import { ApiError, type ProjectGoal } from '@kortix/sdk';
import { useProjectGoal, useProjectGoalFiles, useProjectGoals } from '@kortix/sdk/react';
import { CheckCircleIcon, CircleIcon, WarningIcon } from '@phosphor-icons/react';
import { withoutTitle } from './goal-log';
import { GoalShareModal } from './goal-share-modal';
import { Activity, MessageBox } from './goal-activity';
import { BlockedAction, ControlFailure, GoalControls, useGoalActions, type GoalActions } from './goal-controls';
import { EvidenceFile, GoalDescription, GoalFilesData, GoalFrame, GoalSkeleton, GoalUnavailable, SectionTitle, text } from './goal-parts';
import { GoalRail } from './goal-rail';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';


/**
 * /workspaces/[id]/goals/[goalId] — one goal's home, in two columns. The goal
 * is the server record (`useProjectGoal`): it re-reads every 60 seconds, and
 * every control writes on the revision the page shows.
 *
 * The main column: the outcome, a blocked or failed-control banner, the
 * question it waits on (answered in place), its context from GOAL.md, the
 * done criteria (verified by the independent check, or only reported met by
 * the agent), and the activity feed from the goal's events.
 *
 * The rail: state, agent, next and last check, wakes today against the cap,
 * who it waits on, sessions against the cap, who can see it, the folder.
 *
 * Controls come from `goal.capabilities`: a person who may not pause, stop or
 * answer sees no such control. Each control shows pending, success (a toast)
 * and error (a banner with a retry that finishes it). A `409` means the goal
 * changed under the page: the page shows the goal as it is now and says so.
 *
 * `legacy` is the old `/goals/<scope>/<slug>` link: it opens the goal when
 * the slug names exactly one goal.
 */
export function GoalDetail({ projectId, goalId, legacy }: { projectId: string; goalId?: string; legacy?: { scope: string; slug: string } }) {
  if (legacy) return <LegacyGoalLink projectId={projectId} scope={legacy.scope} slug={legacy.slug} />;
  return <GoalPage projectId={projectId} goalId={goalId ?? ''} />;
}

/** The old `/goals/<scope>/<slug>` link: one goal with that slug opens at its id; several ask which one; none is not found. */
function LegacyGoalLink({ projectId, scope, slug }: { projectId: string; scope: string; slug: string }) {
  const t = useTranslations('goals');
  const router = useRouter();
  const goals = useProjectGoals(projectId);
  const matches = (goals.data ?? []).filter((g) => g.slug === slug && (scope !== 'company' || g.scope === 'company'));
  const only = matches.length === 1 ? matches[0]! : null;
  const target = only ? goalHref(projectId, only) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return (
    <GoalFrame projectId={projectId} title={t('title')}>
      {goals.isError ? (
        <ErrorState size="sm" title={t('loadError')} action={<Button size="sm" variant="outline" onClick={() => goals.refetch()}>{t('retry')}</Button>} />
      ) : goals.isLoading || target ? (
        <GoalSkeleton />
      ) : matches.length === 0 ? (
        <GoalUnavailable projectId={projectId} kind="notFound" />
      ) : (
        <section className="flex max-w-2xl flex-col gap-3" aria-label={t('chooseGoal')}>
          <p className="text-muted-foreground text-sm">{t('chooseGoal')}</p>
          <ul className="flex flex-col">
            {matches.map((g) => (
              <li key={g.goalId}>
                <Link href={goalHref(projectId, g) ?? '#'} className="hover:bg-hover focus-visible:ring-ring flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2">
                  <GoalStatusIcon state={goalIconState(g)} />
                  <span className="text-foreground min-w-0 truncate">{g.record.title}</span>
                  <span className="text-muted-foreground ml-auto min-w-0 truncate text-xs">{g.folder}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </GoalFrame>
  );
}

function GoalPage({ projectId, goalId }: { projectId: string; goalId: string }) {
  const t = useTranslations('goals');
  const query = useProjectGoal(projectId, goalId);
  const goal = query.data ?? null;
  const status = query.error instanceof ApiError ? query.error.status : null;
  const files = useProjectGoalFiles(projectId, goal);
  const actions = useGoalActions(projectId);
  const [sharing, setSharing] = useState(false);

  return (
    <GoalFrame
      projectId={projectId}
      title={goal?.record.title ?? t('title')}
      controls={goal ? <GoalControls projectId={projectId} goal={goal} actions={actions} onShare={() => setSharing(true)} /> : null}
    >
      {goal ? (
        <div className="grid grid-cols-1 gap-12 @4xl/goal:grid-cols-[minmax(0,1fr)_15rem] @4xl/goal:gap-16">
          <GoalMain projectId={projectId} goal={goal} brief={files.data?.brief ?? null} files={files.data ?? null} actions={actions} />
          <GoalRail projectId={projectId} goal={goal} onShare={() => setSharing(true)} />
        </div>
      ) : status === 404 ? (
        <GoalUnavailable projectId={projectId} kind="notFound" />
      ) : status === 403 ? (
        <GoalUnavailable projectId={projectId} kind="noAccess" />
      ) : query.isError ? (
        <ErrorState size="sm" title={t('goalLoadError')} action={<Button size="sm" variant="outline" onClick={() => query.refetch()}>{t('retry')}</Button>} />
      ) : (
        <GoalSkeleton />
      )}
      {goal ? <GoalShareModal projectId={projectId} goal={goal} open={sharing} onOpenChange={setSharing} /> : null}
    </GoalFrame>
  );
}

/** The text `kortix goals new` and the API seed under `## Context`: it says nothing until someone writes there. */
const CONTEXT_PLACEHOLDER = "The request in the person's words, constraints, and what was learned.";

/** GOAL.md as the goal's description: no front matter, no `# title` (the page shows it), no empty seed, no `## Context` heading, no criteria list (the page shows them). */
function goalDescription(brief: string | null): string {
  // Notes for the agent (HTML comments, and the plain line goals created before it was one) are not the brief.
  // Strip comments to a fixed point, an unterminated one to the end, so no `<!--` survives a removal.
  let text = withoutTitle((brief ?? '').replace(/^---\n[\s\S]*?\n---\n?/, ''));
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  }
  return text
    .replace(/^The Kortix API holds this goal's state[^\n]*\n*/m, '')
    .replace(CONTEXT_PLACEHOLDER, '')
    .replace(/\n## (Done criteria|Done when|Success criteria)\b[\s\S]*$/i, '')
    .trim()
    .replace(/^## Context\s*/, '')
    .trim();
}

function GoalMain({ projectId, goal, brief, files, actions }: { projectId: string; goal: ProjectGoal; brief: string | null; files: GoalFilesData | null; actions: GoalActions }) {
  const t = useTranslations('goals');
  const issueText = useGoalIssueText();
  const nextStep = useGoalBlockedNextStep();
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const issues = open && !paused ? goal.health.issues.filter((issue) => issue !== 'blocked') : [];
  const description = goalDescription(brief);
  const counts = goalCriteriaStatus(goal);

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <header className="flex flex-col gap-5" data-testid="goal-overview">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">{record.title}</h2>
        {description ? <GoalDescription markdown={description} /> : null}
      </header>

      <ControlFailure actions={actions} />

      {open && goal.blockedReason ? (
        <BannerAlert variant="warning" data-testid="goal-blocked" data-reason={goal.blockedReason}><BannerAlertMedia><WarningIcon /></BannerAlertMedia><BannerAlertTitle>{t('blockedTitle')}</BannerAlertTitle><BannerAlertDescription>
          {`${issueText('blocked', goal)} ${nextStep(goal) ?? ''}`.trim()}
        </BannerAlertDescription><BannerAlertActions>{<BlockedAction goal={goal} actions={actions} />}</BannerAlertActions></BannerAlert>
      ) : null}

      {record.provenance === 'legacy_unverified' ? (
        <BannerAlert variant="default" data-testid="goal-legacy"><BannerAlertTitle>{t('legacyUnverifiedTitle')}</BannerAlertTitle><BannerAlertDescription>
          {t('legacyUnverified')}
        </BannerAlertDescription></BannerAlert>
      ) : null}

      {waiting ? <QuestionForYou projectId={projectId} goal={goal} actions={actions} /> : null}

      {issues.map((issue) => (
        <BannerAlert variant="warning" key={issue}><BannerAlertMedia><WarningIcon /></BannerAlertMedia><BannerAlertTitle>{t('attentionTitle')}</BannerAlertTitle><BannerAlertDescription>
          {issueText(issue, goal)}
        </BannerAlertDescription></BannerAlert>
      ))}

      <section className="flex flex-col gap-3" aria-label={t('doneWhen')} data-testid="goal-criteria">
        <SectionTitle aside={counts.total ? <span className="text-muted-foreground text-sm tabular-nums">{t('verifiedCount', { verified: counts.verified, total: counts.total })}</span> : null}>
          {t('doneWhen')}
        </SectionTitle>
        {goal.criteria.length ? <CriteriaList projectId={projectId} goal={goal} /> : <p className="text-muted-foreground text-sm">{t('noCriteria')}</p>}
      </section>

      <Activity projectId={projectId} goal={goal} files={files} actions={actions} />
    </div>
  );
}

/**
 * Done criteria in three states: verified (a green check: the independent
 * check passed it), reported met (a grey check: the agent says so, nobody
 * checked yet), not met (an empty circle). A failed check's note sits under
 * the criterion it failed.
 */
function CriteriaList({ projectId, goal }: { projectId: string; goal: ProjectGoal }) {
  const t = useTranslations('goals');
  const driveHref = uiRoutes().drive(projectId);
  const decided = goal.verification && goal.verification.outcome !== 'pending' && goal.verification.criteria_revision === goal.record.criteria_revision ? goal.verification : null;
  return (
    <ul className="flex flex-col gap-2.5 text-sm">
      {goal.criteria.map((c) => {
        const result = decided?.results.find((r) => r.criterion_id === c.id);
        const state = c.verified ? 'verified' : c.reported_met ? 'reported' : 'open';
        return (
          <li key={c.id} className="flex items-start gap-2.5" data-criterion-state={state}>
            {state === 'verified' ? (
              <CheckCircleIcon weight="fill" className="text-kortix-green mt-0.5 size-4 shrink-0" aria-label={t('verified')} />
            ) : state === 'reported' ? (
              <Hint label={t('reportedMetHint')} side="top">
                <span tabIndex={0} className="focus-visible:ring-ring mt-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2">
                  <CheckCircleIcon className="text-muted-foreground size-4" aria-label={t('reportedMet')} />
                </span>
              </Hint>
            ) : (
              <CircleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-label={t('notMet')} />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-foreground">{c.text}</span>
              {state === 'reported' ? <span className="text-muted-foreground text-xs">{t('reportedMet')}</span> : null}
              {result && result.result !== 'pass' && text(result.note) ? (
                <span className="text-muted-foreground text-xs text-pretty">{t('checkFailed', { note: result.note })}</span>
              ) : null}
              {text(c.evidence) ? <EvidenceFile path={text(c.evidence)!} folder={goal.folder} driveHref={driveHref} /> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The question the goal waits on, who it waits on, and the answer box (only for a person who may answer). */
function QuestionForYou({ projectId, goal, actions }: { projectId: string; goal: ProjectGoal; actions: GoalActions }) {
  const t = useTranslations('goals');
  const personOf = useGoalPerson(projectId);
  const question = text(goal.record.waiting_on);
  const who = personOf(goal.record.assigned_user_id ?? goal.record.created_by_user_id);
  return (
    // A callout, not a section: the one place the page asks a person for something.
    <section className="bg-kortix-orange/15 flex flex-col gap-3 rounded-xl p-4" aria-label={t('questionForYou')} data-testid="goal-needs-you">
      <div className="flex items-center gap-2">
        <GoalStatusIcon state="waiting" />
        <h2 className="text-foreground text-sm font-semibold">{goal.capabilities.answer ? t('questionForYou') : t('waitingOnPerson', { person: who ?? t('anotherMember') })}</h2>
      </div>
      {question ? (
        // Agent text: links in it stay clickable; untrusted, so no HTML.
        <div className="text-foreground max-w-prose">
          <UnifiedMarkdown content={question} trust="untrusted" variant="message" className="text-base" />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">{t('waitNoCost')}</p>
      {goal.capabilities.answer ? <MessageBox projectId={projectId} goal={goal} kind="answer" actions={actions} /> : null}
    </section>
  );
}
