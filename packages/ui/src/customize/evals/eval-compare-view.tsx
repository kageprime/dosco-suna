'use client';

import type { WorkspaceEvalCompareCell, WorkspaceEvalCompareRow } from '@kortix/sdk';
import { useWorkspaceEvalCompare } from '@kortix/sdk/react';
import { ArrowDownIcon, ArrowUpIcon, EqualsIcon, MinusIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { LocalTime } from '../../primitives/local-time';
import { Skeleton } from '../../primitives/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Tag } from '../../primitives/tag';
import { UiLink as Link } from '../../providers/ui-provider';
import { agentLabel, evalJobHref, evalJobScore, evalJobsHref, jobSource, percent } from './eval-meta';
import { EVAL_FRAME, EVAL_TIME, EvalDetailPage, InfoHint, ScoreValue } from './eval-ui';

const VIEWS = ['all', 'changed', 'worse', 'better'] as const;
type View = (typeof VIEWS)[number];

const CHANGE = {
  better: { icon: ArrowUpIcon, className: 'text-kortix-green' },
  worse: { icon: ArrowDownIcon, className: 'text-kortix-red' },
  same: { icon: EqualsIcon, className: 'text-muted-foreground' },
  only_one: { icon: MinusIcon, className: 'text-muted-foreground' },
} as const;

/**
 * Customize → Evals → Jobs → Compare (`/admin/eval-jobs/compare?jobs=a,b`):
 * jobs side by side, task by task. The first job is the baseline; `change`
 * reads the last job against it. The way to tell whether an agent got better
 * or worse on the same tasks, and on which ones.
 */
export function EvalCompareView({ projectId, jobIds }: { projectId: string; jobIds: string[] }) {
  const t = useTranslations('evals');
  const [by, setBy] = useState<'task' | 'task_agent_model'>('task');
  const [view, setView] = useState<View>('changed');
  const query = useWorkspaceEvalCompare(projectId, jobIds, by);
  const data = query.data;
  const rows = (data?.rows ?? []).filter(
    (row) =>
      view === 'all' ||
      (view === 'changed' ? row.change === 'better' || row.change === 'worse' : row.change === view),
  );
  const manyAgents = (data?.jobs ?? []).some((job) => job.stats.agents.length > 1);

  return (
    <EvalDetailPage
      wide
      crumbs={[{ label: t('jobsTitle'), href: evalJobsHref(projectId) }, { label: t('compare') }]}
    >
      {jobIds.length < 2 ? (
        <EmptyState
          size="sm"
          title={t('compareNeedsTwo')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href={evalJobsHref(projectId)}>{t('jobsTitle')}</Link>
            </Button>
          }
        />
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title={t('loadError')}
          description={query.error instanceof Error ? query.error.message : undefined}
          action={
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : !data ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      ) : (
        <>
          <header className="flex flex-col gap-1.5">
            <h1 className="text-foreground flex items-center gap-1.5 text-lg font-medium">
              {t('compareTitle', { count: data.jobs.length })}
              <InfoHint text={t('compareInfo')} />
            </h1>
            <p className="text-muted-foreground text-sm" data-testid="evals-compare-summary">
              {t('compareSummary', {
                better: data.summary.better,
                worse: data.summary.worse,
                same: data.summary.same,
                only: data.summary.only_one,
              })}
            </p>
          </header>
          <div className={cn('grid gap-3', data.jobs.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            {data.jobs.map((job, i) => {
              const score = evalJobScore(job);
              return (
                <Link
                  key={job.job_id}
                  href={evalJobHref(projectId, job.job_id)}
                  className={cn(EVAL_FRAME, 'hover:bg-hover flex flex-col gap-1 px-4 py-3 transition-colors')}
                  data-testid="evals-compare-job"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-foreground min-w-0 truncate text-sm font-medium">{job.job_name}</span>
                    {i === 0 ? <Tag>{t('baseline')}</Tag> : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {[jobSource(job), score ? agentLabel(score.agent, score.model) : null].filter(Boolean).join(' · ')}
                  </span>
                  <span className="flex items-baseline justify-between gap-2 pt-1">
                    <ScoreValue rate={score?.passAt1 ?? score?.mean} n={score?.validTrials ?? 0} />
                    <span className="text-muted-foreground text-xs">
                      <LocalTime value={job.created_at} options={EVAL_TIME} />
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={view} onValueChange={(value) => setView(value as View)}>
              <TabsList variant="segmented" aria-label={t('compareView')}>
                {VIEWS.map((value) => (
                  <TabsTrigger key={value} value={value} data-testid={`evals-compare-view-${value}`}>
                    {t(`compareViews.${value}`)}
                    <span className="text-muted-foreground ml-1 tabular-nums">
                      {value === 'all'
                        ? data.rows.length
                        : value === 'changed'
                          ? data.summary.better + data.summary.worse
                          : data.summary[value]}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {manyAgents ? (
              <Tabs value={by} onValueChange={(value) => setBy(value as typeof by)}>
                <TabsList variant="segmented" aria-label={t('compareBy')}>
                  <TabsTrigger value="task">{t('byTask')}</TabsTrigger>
                  <TabsTrigger value="task_agent_model">{t('byTaskAgent')}</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
          {rows.length === 0 ? (
            <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`}>
              {view === 'all' ? t('noCompareRows') : t('noChanges')}
            </div>
          ) : (
            <Table data-testid="evals-compare-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colTask')}</TableHead>
                  {data.jobs.map((job, i) => (
                    <TableHead key={job.job_id} className="max-w-40 truncate text-right" title={job.job_name}>
                      {i === 0 ? t('baseline') : job.job_name}
                    </TableHead>
                  ))}
                  <TableHead className="w-24 text-right">{t('colChange')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <CompareRow key={`${row.task_name}-${row.agent}-${row.model}`} row={row} />
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </EvalDetailPage>
  );
}

function CompareRow({ row }: { row: WorkspaceEvalCompareRow }) {
  const t = useTranslations('evals');
  const change = CHANGE[row.change];
  const Icon = change.icon;
  return (
    <TableRow data-testid="evals-compare-row" data-change={row.change}>
      <TableCell className="max-w-72">
        <span className="text-foreground block truncate font-mono text-sm">{row.task_name}</span>
        {row.agent ? (
          <span className="text-muted-foreground block truncate text-xs">{agentLabel(row.agent, row.model)}</span>
        ) : null}
      </TableCell>
      {row.cells.map((cell) => (
        <TableCell key={cell.job_id} className="text-right">
          <Cell cell={cell} />
        </TableCell>
      ))}
      <TableCell className="w-24 text-right">
        <span className={cn('inline-flex items-center gap-1 text-xs', change.className)}>
          <Icon weight="bold" className="size-3" aria-hidden />
          {t(`changeKind.${row.change}`)}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** One job on one task: the pass rate over its counted attempts, or the error that left none. */
function Cell({ cell }: { cell: WorkspaceEvalCompareCell }) {
  const t = useTranslations('evals');
  if (cell.n === 0)
    return (
      <span className="text-muted-foreground text-xs" title={cell.exception_type ?? undefined}>
        {cell.exception_type ? t('tone.error') : t('notRun')}
      </span>
    );
  const tint = cell.pass_rate === 1 ? 'bg-kortix-green/15' : cell.pass_rate === 0 ? 'bg-kortix-red/15' : 'bg-kortix-orange/15';
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 rounded-sm px-1.5 py-0.5 tabular-nums', tint)}>
      <span className="text-foreground text-sm font-medium">{percent(cell.pass_rate)}</span>
      {cell.n > 1 ? <span className="text-muted-foreground text-xs">{`${cell.n_passed}/${cell.n}`}</span> : null}
    </span>
  );
}
