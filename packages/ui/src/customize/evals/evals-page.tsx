'use client';

import type { WorkspaceEvalJob } from '@kortix/sdk';
import { useWorkspaceEvalJobs, useWorkspaceEvalSuites } from '@kortix/sdk/react';
import { ChartBarIcon, PlayIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { UiLink as Link } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import {
  agentLabel,
  evalDatasetsHref,
  evalJobHref,
  evalJobScore,
  evalJobsHref,
  isOpenJob,
  jobSource,
  leaderboard,
} from './eval-meta';
import {
  EVAL_FRAME,
  InfoHint,
  JobProgress,
  JobsTable,
  LeaderboardTable,
  RunCommand,
  SectionTitle,
  trialCount,
} from './eval-ui';
import { RunEvalModal, type RunTarget } from './run-eval-modal';

// The page's shared pieces moved to eval-ui.tsx; the job view and older imports still read them here.
export { EVAL_FRAME, EVAL_TIME, InfoHint, jobTone } from './eval-ui';

/** Jobs the Overview lists under the leaderboard; the Jobs page lists every one. */
const RECENT = 5;

/**
 * Customize → Evals → Overview: the jobs running now, the leaderboard (each
 * dataset × agent × model: its latest score, its 95% interval and the change
 * since the job before) and the newest jobs. Re-reads every 5 seconds while a
 * job runs.
 */
export function EvalsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('evals');
  const suites = useWorkspaceEvalSuites(projectId);
  const jobs = useWorkspaceEvalJobs(projectId);
  // `false`: closed. A target: the modal opens on it. `null`: the first one.
  const [running, setRunning] = useState<RunTarget | null | false>(false);
  const list = jobs.data ?? [];
  const board = leaderboard(list);
  const open = list.filter(isOpenJob);
  const suiteList = suites.data ?? [];
  const loading = suites.isLoading || jobs.isLoading;

  return (
    <CapabilityPageShell
      title={t('title')}
      description={t('description')}
      titleAddon={<InfoHint text={t('titleInfo')} />}
      action={
        loading ? undefined : (
          <Button size="sm" className="gap-1.5" onClick={() => setRunning(null)} data-testid="evals-run">
            <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {t('newJob')}
          </Button>
        )
      }
    >
      <RunEvalModal
        projectId={projectId}
        suites={suiteList}
        target={running || null}
        open={running !== false}
        onOpenChange={(next) => !next && setRunning(false)}
      />
      {suites.isError && jobs.isError ? (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void Promise.all([suites.refetch(), jobs.refetch()])}
            >
              {t('retry')}
            </Button>
          }
        />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <GetStarted
          hasSuites={suiteList.length > 0}
          projectId={projectId}
          onRun={() =>
            setRunning(
              suiteList[0]?.config
                ? { kind: 'suite', name: suiteList[0].name }
                : { kind: 'dataset', name: 'kortix/my-kortix' },
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {open.length ? <RunningNow projectId={projectId} jobs={open} /> : null}
          <section className="flex flex-col gap-3" aria-label={t('leaderboard')}>
            <SectionTitle title={t('leaderboard')} info={t('leaderboardInfo')} />
            {board.length ? (
              <LeaderboardTable projectId={projectId} rows={board} />
            ) : (
              <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`}>
                {t('noLeaderboard')}
              </div>
            )}
          </section>
          <section className="flex flex-col gap-3" aria-label={t('recentJobs')}>
            <SectionTitle
              title={t('recentJobs')}
              action={
                <Button asChild size="xs" variant="ghost">
                  <Link href={evalJobsHref(projectId)}>{t('allJobs', { count: jobs.total })}</Link>
                </Button>
              }
            />
            <JobsTable projectId={projectId} jobs={list.slice(0, RECENT)} />
          </section>
        </div>
      )}
    </CapabilityPageShell>
  );
}

/** The jobs that have not ended, each with its progress bar. */
function RunningNow({ projectId, jobs }: { projectId: string; jobs: WorkspaceEvalJob[] }) {
  const t = useTranslations('evals');
  return (
    <section className="flex flex-col gap-3" aria-label={t('runningNow')} data-testid="evals-running">
      <SectionTitle title={t('runningNow')} />
      <ul className={`${EVAL_FRAME} divide-border divide-y`}>
        {jobs.map((job) => {
          const score = evalJobScore(job);
          return (
            <li key={job.job_id}>
              <Link
                href={evalJobHref(projectId, job.job_id)}
                className="hover:bg-hover flex items-center gap-4 px-4 py-3 transition-colors"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-foreground truncate text-sm font-medium">{job.job_name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {[jobSource(job), score ? agentLabel(score.agent, score.model) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="flex w-32 shrink-0 flex-col items-end gap-1 sm:w-48">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {t('finishedOf', { count: trialCount(job) })}
                  </span>
                  <JobProgress job={job} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** No job yet: the three ways to start, the first one a click away. */
function GetStarted({
  projectId,
  hasSuites,
  onRun,
}: {
  projectId: string;
  hasSuites: boolean;
  onRun: () => void;
}) {
  const t = useTranslations('evals');
  return (
    <div className="flex flex-col gap-6" data-testid="evals-empty">
      <EmptyState
        media={<EmptyArt icon={ChartBarIcon} />}
        title={t('noJobsTitle')}
        description={t('noJobsDescription')}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={onRun}>
              {hasSuites ? t('runFirstSuite') : t('runBuiltin')}
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={evalDatasetsHref(projectId)}>{t('browseDatasets')}</Link>
            </Button>
          </div>
        }
      />
      <div className="mx-auto flex w-full max-w-xl flex-col gap-2">
        <p className="text-muted-foreground text-xs">{t('startFromCli')}</p>
        <RunCommand command="kortix evals run --dataset kortix/my-kortix --agent <agent>" />
        <p className="text-muted-foreground text-xs">{t('startFromYaml')}</p>
        <pre className={`${EVAL_FRAME} text-foreground overflow-x-auto p-3 font-mono text-xs`}>
          {'evals:\n  smoke:\n    agents: [worker]\n    tasks: [{ path: evals/smoke }]'}
        </pre>
      </div>
    </div>
  );
}
