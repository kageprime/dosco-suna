'use client';

/**
 * The pieces every Evals page shares: the frame, the breadcrumb, the copy and
 * share controls, the run command, the job and leaderboard tables, and the
 * progress bar of a job.
 */
import type { WorkspaceEvalJob } from '@kortix/sdk';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  InfoIcon,
  LinkSimpleIcon,
} from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { CopyButton } from '../../markdown/copy-button';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { LocalTime } from '../../primitives/local-time';
import { StatusBadge, type StatusTone } from '../../primitives/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { errorToast, successToast } from '../../primitives/toast';
import {
  UiLink as Link,
  useUiRouter,
  useUiSearchParams,
  useUiShallowNavigate,
} from '../../providers/ui-provider';
import {
  agentLabel,
  duration,
  evalDatasetHref,
  evalJobHref,
  evalJobScore,
  isOpenJob,
  jobSource,
  passInterval,
  percent,
  ranked,
  usd,
  type LeaderboardRow,
} from './eval-meta';

/** The frame of a list or a matrix: the one the `Table` primitive draws, so every block matches. */
export const EVAL_FRAME = 'border-border bg-popover overflow-hidden rounded-md border';

/** A job's time: day and minute, in the viewer's zone. */
export const EVAL_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** The tone of a job's status: green when every trial ended clean, orange with errors. */
export function jobTone(job: Pick<WorkspaceEvalJob, 'status' | 'stats'>): StatusTone {
  if (job.status === 'completed') return job.stats.n_errored ? 'warning' : 'success';
  if (job.status === 'cancelled') return 'neutral';
  return 'info';
}

/** The `i` beside a title: one explanation, on hover and on focus. */
export function InfoHint({ text }: { text: string }) {
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="text-muted-foreground hover:text-foreground focus-visible:text-foreground inline-flex"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="text-muted-foreground w-72 text-xs">{text}</HoverCardContent>
    </HoverCard>
  );
}

export function SectionTitle({
  title,
  info,
  action,
}: {
  title: string;
  info?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <h2 className="text-foreground flex items-center gap-1.5 text-sm font-medium">
        {title}
        {info ? <InfoHint text={info} /> : null}
      </h2>
      {action}
    </div>
  );
}

/** The page below a section of the Evals group: a scroll column with the breadcrumb on top. */
export function EvalDetailPage({
  crumbs,
  children,
  wide = false,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-6 px-4 pt-5 pb-20 md:px-8',
          wide ? 'max-w-6xl' : 'max-w-5xl',
        )}
      >
        <EvalBreadcrumb crumbs={crumbs} />
        {children}
      </div>
    </div>
  );
}

export function EvalBreadcrumb({ crumbs }: { crumbs: Array<{ label: string; href?: string }> }) {
  const t = useTranslations('evals');
  return (
    <nav aria-label={t('breadcrumb')} data-testid="evals-breadcrumb">
      <ol className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs">
        {crumbs.map((crumb, i) => (
          <Fragment key={`${crumb.label}-${i}`}>
            {i > 0 ? <CaretRightIcon className="size-3 shrink-0" aria-hidden /> : null}
            <li className="min-w-0 truncate">
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-foreground" aria-current="page">
                  {crumb.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** The title of a dataset, a task or a job: monospace, the name copied with one click. */
export function EvalTitle({
  name,
  badge,
  description,
}: {
  name: string;
  badge?: ReactNode;
  description?: ReactNode;
}) {
  const t = useTranslations('evals');
  return (
    <div className="flex min-w-64 flex-1 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="text-foreground min-w-0 font-mono text-lg font-medium wrap-break-word">
          {name}
        </h1>
        <CopyButton code={name} label={t('copyName')} size="sm" />
        {badge}
      </div>
      {description ? (
        <div className="text-muted-foreground text-sm text-pretty">{description}</div>
      ) : null}
    </div>
  );
}

/** Copies the page's link. */
export function ShareButton() {
  const t = useTranslations('evals');
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={() =>
        navigator.clipboard.writeText(window.location.href).then(
          () => successToast(t('linkCopied')),
          () => errorToast(t('copyFailed')),
        )
      }
      data-testid="evals-share"
    >
      <LinkSimpleIcon className="size-3.5" aria-hidden />
      {t('share')}
    </Button>
  );
}

/** One shell command with a copy button: how to run the same thing from the Kortix CLI. */
export function RunCommand({ command }: { command: string }) {
  const t = useTranslations('evals');
  return (
    <div
      className={cn(EVAL_FRAME, 'flex items-center gap-2 py-1.5 pr-1.5 pl-3')}
      data-testid="evals-run-command"
    >
      <span className="text-muted-foreground font-mono text-xs select-none" aria-hidden>
        $
      </span>
      <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" title={command}>
        {command}
      </code>
      <CopyButton code={command} label={t('copyCommand')} size="sm" />
    </div>
  );
}

/** A score with its 95% interval: `82.5% ± 6.1`. */
export function ScoreValue({ rate, n }: { rate: number | null | undefined; n: number }) {
  const t = useTranslations('evals');
  const interval = passInterval(rate, n);
  return (
    <span className="inline-flex items-baseline justify-end gap-1 tabular-nums">
      <span className="text-foreground font-medium">{percent(rate)}</span>
      {/* At 0% or 100% the normal approximation gives ± 0, which reads as certainty: leave it out. */}
      {interval ? (
        <span
          className="text-muted-foreground text-xs"
          title={t('intervalHint', { n })}
          aria-label={t('intervalLabel', { points: Math.round(interval * 1000) / 10 })}
        >
          {`± ${Math.round(interval * 1000) / 10}`}
        </span>
      ) : null}
    </span>
  );
}

/** A change in points, with an arrow: green up, red down. */
export function Change({ value }: { value: number | null }) {
  const t = useTranslations('evals');
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const points = Math.round(value * 1000) / 10;
  if (points === 0) return <span className="text-muted-foreground tabular-nums">±0</span>;
  const up = points > 0;
  const Arrow = up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span
      className="text-foreground inline-flex items-center justify-end gap-1 tabular-nums"
      aria-label={t(up ? 'changeUp' : 'changeDown', { points: Math.abs(points) })}
    >
      <Arrow
        weight="bold"
        className={`size-3 ${up ? 'text-kortix-green' : 'text-kortix-red'}`}
        aria-hidden
      />
      {Math.abs(points)}
    </span>
  );
}

/** Trial counts of a job: the done share as a bar, errors in orange. */
export function JobProgress({ job, className }: { job: WorkspaceEvalJob; className?: string }) {
  const s = job.stats;
  const total = Math.max(1, s.n_total_trials);
  const clean = s.n_completed;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className={cn('bg-muted flex h-1.5 w-full overflow-hidden rounded-full', className)}
      aria-hidden
    >
      <span className="bg-foreground/70 h-full" style={{ width: pct(clean) }} />
      <span className="bg-kortix-orange h-full" style={{ width: pct(s.n_errored) }} />
      <span className="bg-muted-foreground/40 h-full" style={{ width: pct(s.n_cancelled) }} />
      <span className="bg-kortix-blue h-full" style={{ width: pct(s.n_running) }} />
    </div>
  );
}

/** `12/40 · 2 errors`: ended trials over all, with the errors. */
export function trialCount(job: WorkspaceEvalJob): string {
  const s = job.stats;
  return `${s.n_completed + s.n_errored + s.n_cancelled}/${s.n_total_trials}`;
}

/**
 * The jobs table of the Overview, a dataset's Jobs tab and the Jobs page. With
 * `selected`, each row has a checkbox (Compare picks two or more).
 */
export function JobsTable({
  projectId,
  jobs,
  selected,
  onSelect,
  showDataset = true,
}: {
  projectId: string;
  jobs: WorkspaceEvalJob[];
  selected?: ReadonlySet<string>;
  onSelect?: (jobId: string, on: boolean) => void;
  showDataset?: boolean;
}) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const selectable = !!selected && !!onSelect;
  return (
    <Table data-testid="evals-jobs-table">
      <TableHeader>
        <TableRow>
          {selectable ? <TableHead className="w-8" /> : null}
          <TableHead>{t('colJob')}</TableHead>
          <TableHead>{t('colStatus')}</TableHead>
          <TableHead className="hidden w-40 sm:table-cell">{t('colTrials')}</TableHead>
          <TableHead className="text-right">{t('colScore')}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t('colCost')}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t('colStarted')}</TableHead>
          <TableHead className="hidden text-right xl:table-cell">{t('colDuration')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => {
          const score = evalJobScore(job);
          const href = evalJobHref(projectId, job.job_id);
          const s = job.stats;
          const checked = selected?.has(job.job_id) ?? false;
          return (
            <TableRow
              key={job.job_id}
              className="hover:bg-hover cursor-pointer"
              data-state={checked ? 'selected' : undefined}
              onClick={() => router.push(href)}
              data-testid="evals-job-row"
            >
              {selectable ? (
                <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(on) => onSelect!(job.job_id, on === true)}
                    aria-label={t('selectJob', { job: job.job_name })}
                    data-testid="evals-job-select"
                  />
                </TableCell>
              ) : null}
              <TableCell className="max-w-72">
                <Link
                  href={href}
                  className="text-foreground block truncate font-medium"
                  onClick={(e) => e.stopPropagation()}
                >
                  {job.job_name}
                </Link>
                <span className="text-muted-foreground block truncate text-xs">
                  {[showDataset ? jobSource(job) : null, score ? agentLabel(score.agent, score.model) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </TableCell>
              <TableCell>
                <StatusBadge tone={jobTone(job)}>{t(`status.${job.status}`)}</StatusBadge>
              </TableCell>
              <TableCell className="hidden w-40 sm:table-cell">
                <span className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {s.n_errored
                      ? t('trialsWithErrors', { count: trialCount(job), errors: s.n_errored })
                      : trialCount(job)}
                  </span>
                  {isOpenJob(job) ? <JobProgress job={job} /> : null}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <ScoreValue rate={score?.passAt1 ?? score?.mean} n={score?.validTrials ?? 0} />
              </TableCell>
              <TableCell className="text-muted-foreground hidden text-right tabular-nums lg:table-cell">
                {usd(s.usage?.cost_usd)}
              </TableCell>
              <TableCell className="text-muted-foreground hidden text-right md:table-cell">
                <LocalTime value={job.started_at ?? job.created_at} options={EVAL_TIME} />
              </TableCell>
              <TableCell className="text-muted-foreground hidden text-right tabular-nums xl:table-cell">
                {duration(job.started_at, job.finished_at)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * The leaderboard: one row per dataset × agent × model, ranked by score with
 * ties sharing a rank, the score's 95% interval, and the change since the job
 * before. A row opens its latest job.
 */
export function LeaderboardTable({
  projectId,
  rows,
  showDataset = true,
}: {
  projectId: string;
  rows: LeaderboardRow[];
  showDataset?: boolean;
}) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  // Rank within each dataset: scores of two datasets are not comparable.
  const boards = new Map<string, LeaderboardRow[]>();
  for (const row of rows) boards.set(row.suite, [...(boards.get(row.suite) ?? []), row]);
  const list = [...boards.values()].flatMap((board) => ranked(board));
  return (
    <Table data-testid="evals-leaderboard">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10 text-right">#</TableHead>
          {showDataset ? <TableHead>{t('colDataset')}</TableHead> : null}
          <TableHead>{t('colAgent')}</TableHead>
          <TableHead className="text-right">
            <span className="inline-flex items-center gap-1">
              {t('colScore')}
              <InfoHint text={t('scoreColumnInfo')} />
            </span>
          </TableHead>
          <TableHead className="text-right">{t('colChange')}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t('colRuns')}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t('colLast')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((row) => (
          <TableRow
            key={`${row.suite}-${row.agent}-${row.model}`}
            className="hover:bg-hover cursor-pointer"
            onClick={() => router.push(evalJobHref(projectId, row.lastJob.job_id))}
            data-testid="evals-leaderboard-row"
          >
            <TableCell className="text-muted-foreground w-10 text-right tabular-nums">
              {row.rank}
            </TableCell>
            {showDataset ? (
              <TableCell className="max-w-64 truncate font-mono text-xs" title={row.suite}>
                {row.dataset ? (
                  <Link
                    href={evalDatasetHref(projectId, row.dataset, 'leaderboard')}
                    className="text-foreground hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {row.suite}
                  </Link>
                ) : (
                  row.suite
                )}
              </TableCell>
            ) : null}
            <TableCell className="max-w-64 truncate font-medium">
              {agentLabel(row.agent, row.model)}
            </TableCell>
            <TableCell className="text-right">
              <ScoreValue rate={row.passAt1} n={row.n} />
            </TableCell>
            <TableCell className="text-right">
              <Change value={row.change} />
            </TableCell>
            <TableCell className="text-muted-foreground hidden text-right tabular-nums sm:table-cell">
              {row.jobs}
            </TableCell>
            <TableCell className="text-muted-foreground hidden text-right md:table-cell">
              <LocalTime value={row.lastJob.finished_at ?? row.lastJob.created_at} options={EVAL_TIME} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A tab kept in the URL (`?tab=`), so a copied link opens the same tab. The
 * first of `tabs` is the default and is left out of the URL.
 */
export function useUrlTab<T extends string>(tabs: readonly T[]): [T, (tab: T) => void] {
  const params = useUiSearchParams();
  const navigate = useUiShallowNavigate();
  const raw = params.get('tab');
  const current = tabs.find((tab) => tab === raw) ?? tabs[0]!;
  const set = (tab: T) => {
    const next = new URLSearchParams(params.toString());
    if (tab === tabs[0]) next.delete('tab');
    else next.set('tab', tab);
    const query = next.toString();
    navigate(`${window.location.pathname}${query ? `?${query}` : ''}`, { replace: true });
  };
  return [current, set];
}

/** A short line under a tab's table: `Displaying 12 of 40 tasks`. */
export function ListFooter({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs tabular-nums">{children}</p>;
}

