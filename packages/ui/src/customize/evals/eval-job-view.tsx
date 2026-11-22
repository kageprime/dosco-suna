'use client';

import type { WorkspaceEvalJob, WorkspaceEvalTiming, WorkspaceEvalTrial } from '@kortix/sdk';
import {
  useWorkspaceEvalActions,
  useWorkspaceEvalJob,
  useWorkspaceEvalJobs,
  useWorkspaceEvalTrial,
  useWorkspaceEvalTrialFile,
} from '@kortix/sdk/react';
import {
  ArrowCounterClockwiseIcon,
  ArrowsLeftRightIcon,
  CheckIcon,
  MinusIcon,
  StopIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { UnifiedMarkdown } from '../../markdown';
import { HighlightedCode } from '../../markdown/code';
import { CopyButton } from '../../markdown/copy-button';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Hint } from '../../primitives/hint';
import { LocalTime } from '../../primitives/local-time';
import { Skeleton } from '../../primitives/skeleton';
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '../../primitives/split-sheet';
import { StatusBadge } from '../../primitives/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import {
  UiLink as Link,
  useUiRouter,
  useUiSearchParams,
  useUiShallowNavigate,
} from '../../providers/ui-provider';
import {
  agentLabel,
  datasetLabel,
  duration,
  evalCompareHref,
  evalDatasetHref,
  evalJobHref,
  evalJobScore,
  evalJobsHref,
  evalTaskHref,
  evalTrialScore,
  isOpenJob,
  jobDataset,
  jobSource,
  latestRuns,
  percent,
  shortCount,
  trialTone,
  usd,
  type CellTone,
} from './eval-meta';
import {
  EVAL_FRAME,
  EVAL_TIME,
  EvalDetailPage,
  InfoHint,
  jobTone,
  ScoreValue,
  SectionTitle,
  useUrlTab,
} from './eval-ui';

/** A status tint per cell, the solid color on its glyph (color.md → Accents and status). The glyph also reads without color. */
const CELL: Record<CellTone, { tint: string; glyph: ReactNode }> = {
  pass: {
    tint: 'bg-kortix-green/15',
    glyph: <CheckIcon weight="bold" className="text-kortix-green size-3.5" aria-hidden />,
  },
  fail: {
    tint: 'bg-kortix-red/15',
    glyph: <XIcon weight="bold" className="text-kortix-red size-3.5" aria-hidden />,
  },
  error: {
    tint: 'bg-kortix-orange/15',
    glyph: <WarningIcon weight="bold" className="text-kortix-orange size-3.5" aria-hidden />,
  },
  running: {
    tint: 'bg-kortix-blue/15',
    glyph: <span className="bg-kortix-blue size-1.5 rounded-full" aria-hidden />,
  },
  queued: { tint: 'bg-muted', glyph: null },
  cancelled: {
    tint: 'bg-muted',
    glyph: <MinusIcon className="text-muted-foreground size-3.5" aria-hidden />,
  },
};
const LEGEND: CellTone[] = ['pass', 'fail', 'error', 'running', 'queued'];

const seconds = (timing: WorkspaceEvalTiming): string =>
  timing.started_at && timing.finished_at
    ? `${Math.round((Date.parse(timing.finished_at) - Date.parse(timing.started_at)) / 100) / 10} s`
    : '—';

/** What the trial table shows: every trial, or one bucket of the progress bar. */
type TrialFilter = 'all' | CellTone;
const TABS = ['overview', 'health', 'trials', 'config'] as const;
type Tab = (typeof TABS)[number];

/**
 * Customize → Evals → Jobs → one job (`/admin/eval-jobs/<id>`), the Harbor
 * Hub's job page: the progress bar (each bucket filters the trials), then
 * Overview (cost, tokens, the score of each agent × model), Run health (the
 * task × attempt matrix and where errors concentrate), Trials and Config. A
 * trial opens beside the page (`?trial=<id>`). Re-reads every 5 seconds until
 * the job ends.
 */
export function EvalJobView({ projectId, jobId }: { projectId: string; jobId: string }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const params = useUiSearchParams();
  const navigate = useUiShallowNavigate();
  const query = useWorkspaceEvalJob(projectId, jobId);
  const actions = useWorkspaceEvalActions(projectId);
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState<TrialFilter>('all');
  const [tab, setTab] = useUrlTab<Tab>(TABS);
  const job = query.data?.job;
  const trials = query.data?.trials ?? [];
  const dataset = job ? jobDataset(job) : null;
  // The job before this one on the same dataset: what "Compare with previous" opens.
  const siblings = useWorkspaceEvalJobs(
    job && dataset ? projectId : null,
    dataset?.kind === 'suite' ? { suite: dataset.name } : dataset ? { dataset: dataset.name } : undefined,
  );
  const previous = job
    ? (siblings.data ?? []).find(
        (other) =>
          other.job_id !== job.job_id &&
          other.status === 'completed' &&
          Date.parse(other.created_at) < Date.parse(job.created_at),
      )
    : undefined;
  const trialId = params.get('trial');
  const openTrial = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('trial', id);
    else next.delete('trial');
    const q = next.toString();
    navigate(`${window.location.pathname}${q ? `?${q}` : ''}`, { replace: !!id === !!trialId });
  };
  const notFound = query.isError && (query.error as { status?: number } | null)?.status === 404;

  const rerun = (scope: 'failed' | 'all') =>
    actions.rerun.mutate(
      { jobId, scope },
      {
        onSuccess: (next) => {
          successToast(t('rerunStarted', { job: next.job_name }));
          router.push(evalJobHref(projectId, next.job_id));
        },
        onError: (err) => errorToast(err instanceof Error ? err.message : String(err)),
      },
    );
  const hasFailed = trials.some(
    (trial) => !evalTrialScore(trial).passed && trial.status !== 'cancelled',
  );
  const showTrials = (tone: TrialFilter) => {
    setFilter(tone);
    setTab('trials');
  };

  return (
    <SplitSheet
      open={!!trialId}
      onOpenChange={(next) => !next && openTrial(null)}
      size="lg"
      className="min-h-0 flex-1 [--split-sheet-max:55%] [--split-sheet-width:45%]"
    >
      <SplitSheetMain className="flex min-h-0 flex-col">
        <EvalDetailPage
          crumbs={[
            { label: t('jobsTitle'), href: evalJobsHref(projectId) },
            { label: job?.job_name ?? '…' },
          ]}
        >
          {notFound ? (
            <EmptyState
              size="sm"
              title={t('jobNotFound')}
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
              action={
                <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          ) : !job ? (
            <div className="flex flex-col gap-3" aria-busy>
              <Skeleton className="h-7 w-72" />
              <Skeleton className="h-4 w-96" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-40 w-full rounded-lg" />
            </div>
          ) : (
            <>
              <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h1 className="text-foreground min-w-0 text-xl font-medium wrap-break-word">
                      {job.job_name}
                    </h1>
                    <StatusBadge tone={jobTone(job)}>{t(`status.${job.status}`)}</StatusBadge>
                  </div>
                  <Summary projectId={projectId} job={job} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isOpenJob(job) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={actions.cancel.isPending}
                      aria-busy={actions.cancel.isPending}
                      onClick={() =>
                        actions.cancel.mutate(jobId, {
                          onSuccess: () => successToast(t('cancelled')),
                        })
                      }
                      data-testid="evals-cancel"
                    >
                      <StopIcon className="size-3.5" aria-hidden />
                      {t('cancel')}
                    </Button>
                  ) : (
                    <>
                      {previous ? (
                        <Button asChild size="sm" variant="outline" className="gap-1.5">
                          <Link
                            href={evalCompareHref(projectId, [previous.job_id, job.job_id])}
                            data-testid="evals-compare-previous"
                          >
                            <ArrowsLeftRightIcon className="size-3.5" aria-hidden />
                            {t('compareWithPrevious')}
                          </Link>
                        </Button>
                      ) : null}
                      {hasFailed ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={actions.rerun.isPending}
                          onClick={() => rerun('failed')}
                          data-testid="evals-rerun-failed"
                        >
                          <ArrowCounterClockwiseIcon className="size-3.5" aria-hidden />
                          {t('rerunFailed')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant={hasFailed || previous ? 'ghost' : 'outline'}
                        disabled={actions.rerun.isPending}
                        onClick={() => rerun('all')}
                        data-testid="evals-rerun-all"
                      >
                        {t('rerunAll')}
                      </Button>
                      <Hint label={t('delete')}>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('delete')}
                          onClick={() => setDeleting(true)}
                        >
                          <TrashIcon className="size-4" />
                        </Button>
                      </Hint>
                    </>
                  )}
                </div>
              </header>
              <Progress job={job} trials={trials} onShow={showTrials} />
              <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
                <TabsList className="w-fit">
                  {TABS.map((value) => (
                    <TabsTrigger key={value} value={value} data-testid={`evals-tab-${value}`}>
                      {t(`jobTab.${value}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="overview" className="flex flex-col gap-6 pt-4">
                  <StatCards job={job} trials={trials} />
                  <Scores job={job} trials={trials} compact={!!trialId} />
                </TabsContent>
                <TabsContent value="health" className="flex flex-col gap-6 pt-4">
                  <Matrix trials={trials} selected={trialId} onOpen={openTrial} />
                  <Failures trials={trials} onShow={() => showTrials('error')} />
                </TabsContent>
                <TabsContent value="trials" className="pt-4">
                  <TrialTable
                    trials={trials}
                    filter={filter}
                    onFilter={setFilter}
                    selected={trialId}
                    onOpen={openTrial}
                  />
                </TabsContent>
                <TabsContent value="config" className="pt-4">
                  <ConfigView job={job} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </EvalDetailPage>
      </SplitSheetMain>
      {trialId ? <TrialPanel projectId={projectId} jobId={jobId} trialId={trialId} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteTitle')}
        description={t('deleteDescription')}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={actions.remove.isPending}
        onConfirm={() =>
          actions.remove.mutate(jobId, {
            onSuccess: () => {
              successToast(t('deleted'));
              router.push(evalJobsHref(projectId));
            },
            onError: (err) => errorToast(err instanceof Error ? err.message : String(err)),
          })
        }
      />
    </SplitSheet>
  );
}

function Summary({ projectId, job }: { projectId: string; job: WorkspaceEvalJob }) {
  const t = useTranslations('evals');
  const dataset = jobDataset(job);
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      data-testid="evals-job-summary"
    >
      {dataset ? (
        <Link href={evalDatasetHref(projectId, dataset)} className="hover:text-foreground font-mono">
          {datasetLabel(dataset)}
        </Link>
      ) : (
        <span className="font-mono">{jobSource(job)}</span>
      )}
      {job.commit ? <span className="font-mono">{job.commit.slice(0, 7)}</span> : null}
      <LocalTime value={job.created_at} options={EVAL_TIME} />
      {job.rerun_of ? (
        <Link
          href={evalJobHref(projectId, job.rerun_of)}
          className="hover:text-foreground underline underline-offset-2"
        >
          {t('rerunOf', { job: job.rerun_of.slice(0, 8) })}
        </Link>
      ) : null}
    </div>
  );
}

/** The bar's buckets, in the order they fill. */
const BUCKETS: Array<{ tone: CellTone; bar: string }> = [
  { tone: 'pass', bar: 'bg-kortix-green' },
  { tone: 'fail', bar: 'bg-kortix-red' },
  { tone: 'error', bar: 'bg-kortix-orange' },
  { tone: 'running', bar: 'bg-kortix-blue' },
  { tone: 'queued', bar: 'bg-muted-foreground/30' },
  { tone: 'cancelled', bar: 'bg-muted-foreground/60' },
];

/** "18 / 40 finished": one stacked bar over the last run of each attempt; each legend item shows its trials. */
function Progress({
  job,
  trials,
  onShow,
}: {
  job: WorkspaceEvalJob;
  trials: WorkspaceEvalTrial[];
  onShow: (tone: CellTone) => void;
}) {
  const t = useTranslations('evals');
  // Counted from the trials: the job's stats are recomputed once per runner tick and lag by up to one.
  const runs = latestRuns(trials);
  const counts = new Map<CellTone, number>();
  for (const trial of runs) counts.set(trialTone(trial), (counts.get(trialTone(trial)) ?? 0) + 1);
  const total = runs.length || job.stats.n_total_trials;
  const done = runs.filter((trial) => !isOpenTrial(trial)).length;
  return (
    <section className={`${EVAL_FRAME} flex flex-col gap-3 px-4 py-3`} aria-label={t('progressLabel')} data-testid="evals-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-foreground text-sm font-medium tabular-nums">
          {t('finishedOf', { count: `${done} / ${total}` })}
        </span>
        <span className="text-muted-foreground">
          {job.started_at
            ? t(isOpenJob(job) ? 'runningFor' : 'ranFor', {
                time: duration(job.started_at, job.finished_at),
              })
            : t('waitingToStart')}
        </span>
      </div>
      <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full" aria-hidden>
        {BUCKETS.map(({ tone, bar }) =>
          counts.get(tone) ? (
            <span
              key={tone}
              className={cn('h-full', bar)}
              style={{ width: `${((counts.get(tone) ?? 0) / Math.max(1, total)) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <ul className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label={t('legend')}>
        {BUCKETS.filter(({ tone }) => counts.get(tone) || tone === 'pass' || tone === 'fail').map(({ tone, bar }) => (
          <li key={tone}>
            <button
              type="button"
              onClick={() => onShow(tone)}
              className="text-muted-foreground hover:text-foreground hover:bg-hover flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 transition-colors"
              aria-label={t('showTrials', { count: counts.get(tone) ?? 0, tone: t(`tone.${tone}`) })}
              data-testid={`evals-bucket-${tone}`}
            >
              <span className={cn('size-2 rounded-full', bar)} aria-hidden />
              <span className="text-foreground tabular-nums">{counts.get(tone) ?? 0}</span>
              {t(`tone.${tone}`)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const isOpenTrial = (trial: WorkspaceEvalTrial) =>
  trial.status === 'queued' ||
  trial.status === 'starting' ||
  trial.status === 'agent_running' ||
  trial.status === 'verifying';

/** Score, tokens, cost and time, one card each. */
function StatCards({ job, trials }: { job: WorkspaceEvalJob; trials: WorkspaceEvalTrial[] }) {
  const t = useTranslations('evals');
  const score = evalJobScore(job);
  const usage = job.stats.usage;
  const ended = latestRuns(trials).filter((trial) => !isOpenTrial(trial)).length;
  const tokens = usage ? usage.n_input_tokens + usage.n_output_tokens + usage.n_cache_tokens : null;
  const cards: Array<{ label: string; value: ReactNode; hint?: string }> = [
    {
      label: score?.passAt1 !== null && score?.passAt1 !== undefined ? t('passAt1') : t('meanScore'),
      value: <ScoreValue rate={score?.passAt1 ?? score?.mean} n={score?.validTrials ?? 0} />,
      hint: score ? t('acrossScored', { n: score.validTrials }) : undefined,
    },
    {
      label: t('tokensLabel'),
      value: shortCount(tokens),
      hint:
        usage && tokens
          ? t('cacheShare', { pct: Math.round((usage.n_cache_tokens / tokens) * 100) })
          : undefined,
    },
    {
      label: t('cost'),
      value: usd(usage?.cost_usd),
      hint:
        usage?.cost_usd && ended ? t('perTrial', { cost: usd(usage.cost_usd / ended) }) : undefined,
    },
    {
      label: t('colDuration'),
      value: duration(job.started_at, job.finished_at),
      hint: t('concurrencyHint', { n: job.config.n_concurrent_trials }),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="evals-stat-cards">
      {cards.map((card) => (
        <div key={card.label} className={`${EVAL_FRAME} flex flex-col gap-1 px-4 py-3`}>
          <span className="text-muted-foreground text-xs">{card.label}</span>
          <span className="text-foreground text-lg font-medium tabular-nums">{card.value}</span>
          {card.hint ? <span className="text-muted-foreground text-xs">{card.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Where errors concentrate: the top exception types and the tasks with errors. */
function Failures({ trials, onShow }: { trials: WorkspaceEvalTrial[]; onShow: () => void }) {
  const t = useTranslations('evals');
  const errored = latestRuns(trials).filter((trial) => trial.exception);
  if (errored.length === 0) return null;
  const tally = (key: (trial: WorkspaceEvalTrial) => string) => {
    const counts = new Map<string, number>();
    for (const trial of errored) counts.set(key(trial), (counts.get(key(trial)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  };
  const types = tally((trial) => trial.exception!.exception_type);
  const tasks = tally((trial) => trial.task_name);
  const max = Math.max(...types.map(([, n]) => n), ...tasks.map(([, n]) => n));
  const list = (title: string, rows: Array<[string, number]>, mono: boolean) => (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {rows.map(([name, n]) => (
          <li key={name} className="flex items-center gap-2 text-xs">
            <span className={cn('text-foreground w-40 shrink-0 truncate', mono && 'font-mono')} title={name}>
              {name}
            </span>
            <span className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
              <span className="bg-kortix-orange block h-full" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="text-muted-foreground w-6 text-right tabular-nums">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <section className="flex flex-col gap-3" aria-label={t('failures')} data-testid="evals-failures">
      <SectionTitle
        title={t('failures')}
        info={t('failuresInfo')}
        action={
          <Button size="xs" variant="ghost" onClick={onShow}>
            {t('reviewErrors', { count: errored.length })}
          </Button>
        }
      />
      <div className={`${EVAL_FRAME} grid gap-6 px-4 py-4 md:grid-cols-2`}>
        {list(t('topExceptions'), types, true)}
        {list(t('tasksWithErrors'), tasks, true)}
      </div>
    </section>
  );
}

const FILTERS: TrialFilter[] = ['all', 'pass', 'fail', 'error', 'running', 'queued', 'cancelled'];

/** Every trial (the last run of each attempt), filtered by bucket; a row opens the trial. */
function TrialTable({
  trials,
  filter,
  onFilter,
  selected,
  onOpen,
}: {
  trials: WorkspaceEvalTrial[];
  filter: TrialFilter;
  onFilter: (filter: TrialFilter) => void;
  selected: string | null;
  onOpen: (trialId: string) => void;
}) {
  const t = useTranslations('evals');
  const runs = latestRuns(trials).sort(
    (a, b) => a.task_name.localeCompare(b.task_name) || a.agent.localeCompare(b.agent) || a.attempt - b.attempt,
  );
  const count = (tone: TrialFilter) => (tone === 'all' ? runs.length : runs.filter((trial) => trialTone(trial) === tone).length);
  const shown = filter === 'all' ? runs : runs.filter((trial) => trialTone(trial) === filter);
  return (
    <div className="flex flex-col gap-3" data-testid="evals-trials">
      <Tabs value={filter} onValueChange={(value) => onFilter(value as TrialFilter)}>
        <TabsList variant="segmented" className="w-fit max-w-full overflow-x-auto" aria-label={t('trialFilter')}>
          {FILTERS.filter((tone) => tone === 'all' || count(tone) > 0 || tone === filter).map((tone) => (
            <TabsTrigger key={tone} value={tone} data-testid={`evals-trials-filter-${tone}`}>
              {tone === 'all' ? t('allTrials') : t(`tone.${tone}`)}
              <span className="text-muted-foreground ml-1 tabular-nums">{count(tone)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {shown.length === 0 ? (
        <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`}>{t('noTrialMatch')}</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colTask')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('colAgent')}</TableHead>
              <TableHead>{t('colResult')}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t('colReward')}</TableHead>
              <TableHead className="hidden text-right lg:table-cell">{t('colDuration')}</TableHead>
              <TableHead className="hidden text-right lg:table-cell">{t('tokensLabel')}</TableHead>
              <TableHead className="hidden text-right xl:table-cell">{t('cost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((trial) => {
              const tone = trialTone(trial);
              const usage = trial.usage;
              return (
                <TableRow
                  key={trial.trial_id}
                  className="hover:bg-hover cursor-pointer"
                  data-state={selected === trial.trial_id ? 'selected' : undefined}
                  onClick={() => onOpen(trial.trial_id)}
                  data-testid="evals-trial-row"
                >
                  <TableCell className="max-w-64">
                    <button
                      type="button"
                      className="text-foreground block max-w-full truncate text-left font-mono text-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(trial.trial_id);
                      }}
                    >
                      {trial.task_name}
                    </button>
                    {trial.attempt > 1 || trial.retry > 0 ? (
                      <span className="text-muted-foreground text-xs">
                        {[trial.attempt > 1 ? t('attempt', { n: trial.attempt }) : null, trial.retry ? t('retryN', { n: trial.retry }) : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-48 truncate md:table-cell">
                    {agentLabel(trial.agent, trial.model)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col gap-0.5">
                      <StatusBadge tone={TONE_BADGE[tone]}>{t(`tone.${tone}`)}</StatusBadge>
                      {trial.exception ? (
                        <span className="text-muted-foreground max-w-40 truncate font-mono text-xs" title={trial.exception.exception_message}>
                          {trial.exception.exception_type}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right font-mono text-xs tabular-nums sm:table-cell">
                    {trial.rewards
                      ? Object.values(trial.rewards)
                          .map((value) => value.toFixed(2))
                          .join(' · ')
                      : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums lg:table-cell">
                    {isOpenTrial(trial) && trial.started_at ? '…' : duration(trial.started_at, trial.finished_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums lg:table-cell">
                    {usage ? shortCount(usage.n_input_tokens + usage.n_output_tokens + usage.n_cache_tokens) : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right tabular-nums xl:table-cell">
                    {usd(usage?.cost_usd)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** The job config as JSON (secret values come back redacted from the API). */
function ConfigView({ job }: { job: WorkspaceEvalJob }) {
  const t = useTranslations('evals');
  const text = JSON.stringify(job.config, null, 2);
  return (
    <div className={EVAL_FRAME} data-testid="evals-config">
      <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{`${job.folder}/config.json`}</span>
        <CopyButton code={text} label={t('copyConfig')} size="sm" />
      </div>
      <pre className="text-foreground max-h-[36rem] overflow-auto p-4 font-mono text-xs [&_.shiki]:!bg-transparent [&_code]:bg-transparent [&_span]:!bg-transparent">
        <HighlightedCode code={text} language="json" />
      </pre>
    </div>
  );
}

const TONE_BADGE = {
  pass: 'success',
  fail: 'destructive',
  error: 'warning',
  running: 'info',
  queued: 'neutral',
  cancelled: 'neutral',
} as const;

function Scores({
  job,
  trials,
  compact,
}: {
  job: WorkspaceEvalJob;
  trials: WorkspaceEvalTrial[];
  /** A trial is open beside the page: leave out Pass@k and Valid so the table fits the narrower column. */
  compact: boolean;
}) {
  const t = useTranslations('evals');
  if (!job.stats.agents.length) return null;
  // The mean of each valid trial's own score (the mean of its rewards): one number per agent that reads
  // the same whatever reward keys each task writes. Harbor's per-key metrics stay one hover away.
  const runs = latestRuns(trials);
  const meanScore = (agent: string, model: string | null) => {
    const scores = runs
      .filter((trial) => trial.agent === agent && (trial.model ?? null) === (model ?? null))
      .map((trial) => evalTrialScore(trial).score)
      .filter((score): score is number => score !== null);
    return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  };
  return (
    <section className="flex flex-col gap-3" aria-label={t('scores')}>
      <h2 className="text-foreground flex items-center gap-1.5 text-sm font-medium">
        {t('scores')}
        <InfoHint text={t('scoresInfo')} />
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('colAgent')}</TableHead>
            <TableHead className="text-right">{t('colScore')}</TableHead>
            {compact ? null : (
              <TableHead className="hidden sm:table-cell">{t('colPassK')}</TableHead>
            )}
            <TableHead className="hidden text-right sm:table-cell">{t('colMeanScore')}</TableHead>
            {compact ? null : <TableHead className="text-right">{t('colValid')}</TableHead>}
            <TableHead className="text-right">{t('colErrors')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {job.stats.agents.map((agent) => (
            <TableRow key={`${agent.agent}-${agent.model}-${agent.source}`} data-testid="evals-score-row">
              <TableCell className="max-w-64">
                <span className="block truncate font-medium">{agentLabel(agent.agent, agent.model)}</span>
                {agent.source ? (
                  <span className="text-muted-foreground block truncate font-mono text-xs">{agent.source}</span>
                ) : null}
              </TableCell>
              <TableCell className="text-right text-base">
                <ScoreValue rate={agent.pass_at_k['1']} n={agent.n_trials} />
              </TableCell>
              {compact ? null : (
                <TableCell className="text-muted-foreground hidden text-xs tabular-nums sm:table-cell">
                  {Object.entries(agent.pass_at_k)
                    .map(([k, v]) => `@${k} ${percent(v)}`)
                    .join('  ')}
                </TableCell>
              )}
              <TableCell className="hidden text-right tabular-nums sm:table-cell">
                <span className="inline-flex items-center justify-end gap-1.5">
                  {percent(meanScore(agent.agent, agent.model))}
                  <InfoHint
                    text={t('metricsHint', {
                      metrics: agent.metrics
                        .map((m) =>
                          Object.entries(m)
                            .map(([k, v]) => `${k} ${v.toFixed(2)}`)
                            .join(', '),
                        )
                        .join(' · '),
                    })}
                  />
                </span>
              </TableCell>
              {compact ? null : (
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {agent.n_trials}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {agent.n_errors ? (
                  <span className="text-foreground inline-flex items-center gap-1">
                    <WarningIcon weight="bold" className="text-kortix-orange size-3" aria-hidden />
                    {agent.n_errors}
                  </span>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function Matrix({
  trials,
  selected,
  onOpen,
}: {
  trials: WorkspaceEvalTrial[];
  selected: string | null;
  onOpen: (trialId: string) => void;
}) {
  const t = useTranslations('evals');
  const runs = latestRuns(trials);
  const tasks = [...new Set(runs.map((trial) => trial.task_name))].sort();
  const columns = [
    ...new Map(
      runs.map((trial) => [
        `${agentLabel(trial.agent, trial.model)}\u0000${trial.attempt}`,
        { agent: agentLabel(trial.agent, trial.model), attempt: trial.attempt },
      ]),
    ).values(),
  ].sort((a, b) => a.agent.localeCompare(b.agent) || a.attempt - b.attempt);
  const cell = new Map(
    runs.map((trial) => [
      `${trial.task_name}\u0000${agentLabel(trial.agent, trial.model)}\u0000${trial.attempt}`,
      trial,
    ]),
  );
  const agents = [...new Set(columns.map((c) => c.agent))];
  // With one attempt per agent the attempt row says nothing.
  const multiAttempt = columns.length > agents.length;
  return (
    <section className="flex flex-col gap-3" aria-label={t('matrix')} data-testid="evals-matrix">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-foreground flex items-center gap-1.5 text-sm font-medium">
          {t('matrix')}
          <InfoHint text={t('matrixInfo')} />
        </h2>
        <ul
          className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          aria-label={t('legend')}
        >
          {LEGEND.map((tone) => (
            <li key={tone} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-sm [&_svg]:size-2.5',
                  CELL[tone].tint,
                )}
              >
                {CELL[tone].glyph}
              </span>
              {t(`tone.${tone}`)}
            </li>
          ))}
        </ul>
      </div>
      <div className={`${EVAL_FRAME} overflow-x-auto p-4`}>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="text-muted-foreground pr-4 pb-1 text-left font-medium">
                {multiAttempt ? null : t('colTasks')}
              </th>
              {agents.map((agent) => (
                <th
                  key={agent}
                  colSpan={columns.filter((c) => c.agent === agent).length}
                  className="text-muted-foreground max-w-48 truncate px-1 pb-1 text-left font-medium whitespace-nowrap"
                  title={agent}
                >
                  {agent}
                </th>
              ))}
            </tr>
            {multiAttempt ? (
              <tr>
                <th className="text-muted-foreground pr-4 pb-1 text-left font-medium">
                  {t('colTasks')}
                </th>
                {columns.map((c) => (
                  <th
                    key={`${c.agent}-${c.attempt}`}
                    className="text-muted-foreground px-1 pb-1 text-left font-normal tabular-nums"
                  >
                    {t('attempt', { n: c.attempt })}
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task}>
                <td className="text-foreground max-w-64 truncate py-0.5 pr-4 font-mono">{task}</td>
                {columns.map((c) => {
                  const trial = cell.get(`${task}\u0000${c.agent}\u0000${c.attempt}`);
                  if (!trial) return <td key={`${c.agent}-${c.attempt}`} />;
                  const tone = trialTone(trial);
                  return (
                    <td key={`${c.agent}-${c.attempt}`} className="px-1 py-0.5">
                      <button
                        type="button"
                        onClick={() => onOpen(trial.trial_id)}
                        aria-pressed={selected === trial.trial_id}
                        aria-label={`${task} · ${c.agent} · ${t('attempt', { n: c.attempt })}: ${t(`tone.${tone}`)}`}
                        className={cn(
                          'hover:ring-ring focus-visible:ring-ring flex size-7 items-center justify-center rounded-sm outline-none hover:ring-1 focus-visible:ring-2',
                          CELL[tone].tint,
                          selected === trial.trial_id && 'ring-foreground ring-2',
                        )}
                        data-testid="evals-cell"
                        data-tone={tone}
                      >
                        {CELL[tone].glyph}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The phases of a trial on one bar: sandbox, agent, verifier. */
function TimingBar({ trial }: { trial: WorkspaceEvalTrial }) {
  const t = useTranslations('evals');
  const ms = (timing: WorkspaceEvalTiming) =>
    timing.started_at && timing.finished_at ? Math.max(0, Date.parse(timing.finished_at) - Date.parse(timing.started_at)) : 0;
  const phases = [
    { label: t('sandbox'), ms: ms(trial.environment_setup), bar: 'bg-muted-foreground/50' },
    { label: t('agentTime'), ms: ms(trial.agent_execution), bar: 'bg-foreground/70' },
    { label: t('verifierTime'), ms: ms(trial.verifier), bar: 'bg-kortix-blue' },
  ];
  const total = phases.reduce((sum, phase) => sum + phase.ms, 0);
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="evals-trial-timing">
      <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full" aria-hidden>
        {phases.map((phase) =>
          phase.ms ? <span key={phase.label} className={cn('h-full', phase.bar)} style={{ width: `${(phase.ms / total) * 100}%` }} /> : null,
        )}
      </div>
      <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        {phases.map((phase) => (
          <li key={phase.label} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', phase.bar)} aria-hidden />
            {phase.label}
            <span className="text-foreground">{phase.ms ? `${Math.round(phase.ms / 100) / 10} s` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One trial, beside the page: result and error, timing and tokens, retry, the instruction, and its files. */
function TrialPanel({
  projectId,
  jobId,
  trialId,
}: {
  projectId: string;
  jobId: string;
  trialId: string;
}) {
  const t = useTranslations('evals');
  const detail = useWorkspaceEvalTrial(projectId, jobId, trialId);
  const actions = useWorkspaceEvalActions(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const files = detail.data?.files ?? [];
  // The verifier's own output first: it says why the score is what it is.
  const path =
    picked && files.some((f) => f.path === picked)
      ? picked
      : ((files.find((f) => f.path === 'verifier/test-stdout.txt') ?? files[0])?.path ?? null);
  const file = useWorkspaceEvalTrialFile(projectId, jobId, trialId, path);
  const trial = detail.data?.trial;
  const score = trial ? evalTrialScore(trial) : null;
  const tone = trial ? trialTone(trial) : null;
  const ended = !!trial && (trial.status === 'completed' || trial.status === 'errored' || trial.status === 'cancelled');
  const usage = trial?.usage;

  return (
    <SplitSheetContent data-testid="evals-trial-sheet">
      <PanelFocus key={trialId}>
        <SplitSheetHeader closeLabel={t('close')}>
          <SplitSheetTitle className="font-mono">{trial?.task_name ?? t('trial')}</SplitSheetTitle>
          <SplitSheetDescription>
            {trial
              ? [agentLabel(trial.agent, trial.model), t('attempt', { n: trial.attempt }), trial.retry ? t('retryN', { n: trial.retry }) : null]
                  .filter(Boolean)
                  .join(' · ')
              : ' '}
          </SplitSheetDescription>
        </SplitSheetHeader>
        <SplitSheetBody className="flex flex-col gap-6">
          {!trial ? (
            <div className="flex flex-col gap-2" aria-busy>
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={TONE_BADGE[tone!]} data-testid="evals-trial-result">
                    {t(`tone.${tone}`)}
                  </StatusBadge>
                  {trial.rewards
                    ? Object.entries(trial.rewards).map(([name, value]) => (
                        <span key={name} className="text-muted-foreground font-mono text-xs tabular-nums">{`${name} ${value}`}</span>
                      ))
                    : null}
                </div>
                {score && trial.rewards && !trial.reward_valid ? (
                  <p className="text-muted-foreground text-xs">{t('rewardInvalid')}</p>
                ) : null}
                {trial.exception ? (
                  <div className="bg-kortix-orange/15 flex flex-col gap-1 rounded-md p-3 text-xs" data-testid="evals-trial-error">
                    <span className="text-foreground font-medium wrap-break-word">{`${trial.exception.exception_type}: ${trial.exception.exception_message}`}</span>
                    <span className="text-muted-foreground">
                      {t('policy', {
                        retry: trial.exception.policy.should_retry ? t('yes') : t('no'),
                        grade: trial.exception.policy.should_grade ? t('yes') : t('no'),
                        valid: trial.exception.policy.has_valid_reward ? t('yes') : t('no'),
                      })}
                    </span>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  {ended ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={actions.retryTrial.isPending}
                      aria-busy={actions.retryTrial.isPending}
                      onClick={() =>
                        actions.retryTrial.mutate(
                          { jobId, trialId },
                          {
                            onSuccess: () => successToast(t('trialRetried')),
                            onError: (err) => errorToast(err instanceof Error ? err.message : String(err)),
                          },
                        )
                      }
                      data-testid="evals-trial-retry"
                    >
                      <ArrowCounterClockwiseIcon className="size-3.5" aria-hidden />
                      {t('retryTrial')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={actions.cancelTrial.isPending}
                      onClick={() =>
                        actions.cancelTrial.mutate(
                          { jobId, trialId },
                          {
                            onSuccess: () => successToast(t('trialCancelled')),
                            onError: (err) => errorToast(err instanceof Error ? err.message : String(err)),
                          },
                        )
                      }
                      data-testid="evals-trial-cancel"
                    >
                      <StopIcon className="size-3.5" aria-hidden />
                      {t('cancelTrial')}
                    </Button>
                  )}
                  {trial.session_id ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/workspaces/${projectId}/sessions/${trial.session_id}`}>{t('openSession')}</Link>
                    </Button>
                  ) : null}
                  {trial.task_id ? (
                    <Button asChild size="sm" variant="ghost">
                      <Link href={evalTaskHref(projectId, trial.task_id)}>{t('openTask')}</Link>
                    </Button>
                  ) : null}
                </div>
              </section>
              <section className="flex flex-col gap-3">
                <h3 className="text-muted-foreground text-xs font-medium">{t('timings')}</h3>
                <TimingBar trial={trial} />
                {usage ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs tabular-nums">
                    <dt className="text-muted-foreground">{t('tokensLabel')}</dt>
                    <dd className="text-foreground">
                      {t('tokensDetail', {
                        input: usage.n_input_tokens.toLocaleString(),
                        output: usage.n_output_tokens.toLocaleString(),
                        cache: usage.n_cache_tokens.toLocaleString(),
                      })}
                    </dd>
                    <dt className="text-muted-foreground">{t('cost')}</dt>
                    <dd className="text-foreground">{usd(usage.cost_usd)}</dd>
                  </dl>
                ) : null}
              </section>
              {detail.data?.instruction ? (
                <section className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-xs font-medium">{t('instruction')}</h3>
                  <div className="text-foreground text-sm" data-testid="evals-trial-instruction">
                    {/* A task's instruction is someone else's text: untrusted, no HTML, no remote images. */}
                    <UnifiedMarkdown content={detail.data.instruction} trust="untrusted" variant="document" />
                  </div>
                </section>
              ) : null}
              <section className="flex flex-col gap-2">
                <h3 className="text-muted-foreground text-xs font-medium">{t('files')}</h3>
                {files.length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t('noFiles')}</p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('files')}>
                      {files.map((f) => (
                        <Button
                          key={f.path}
                          role="tab"
                          aria-selected={f.path === path}
                          size="xs"
                          variant={f.path === path ? 'secondary' : 'ghost'}
                          className="font-mono"
                          onClick={() => setPicked(f.path)}
                        >
                          {f.path}
                        </Button>
                      ))}
                    </div>
                    <div className="relative">
                      {file.data ? (
                        <CopyButton code={file.data} label={t('copyFile')} size="sm" className="absolute top-1.5 right-1.5" />
                      ) : null}
                      <pre
                        className="bg-muted text-foreground max-h-[28rem] overflow-auto rounded-md p-3 pr-10 font-mono text-xs wrap-break-word whitespace-pre-wrap"
                        data-testid="evals-trial-file"
                      >
                        {file.isLoading ? '…' : (file.data ?? '')}
                      </pre>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </SplitSheetBody>
      </PanelFocus>
    </SplitSheetContent>
  );
}

/**
 * A cell opens the panel, not a `SplitSheetTrigger`, so focus moves in here on
 * open (Escape inside the sheet closes it) and goes back to the cell on close,
 * as the Triggers panel does.
 */
function PanelFocus({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.focus({ preventScroll: true });
    return () => {
      // Layout cleanup runs before the panel detaches, so focus is still readable.
      if (panel?.contains(document.activeElement) && opener?.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      {children}
    </div>
  );
}
