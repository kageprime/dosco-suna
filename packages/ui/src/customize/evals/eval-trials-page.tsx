'use client';

import type { WorkspaceEvalTrialFilters, WorkspaceEvalTrialListItem, WorkspaceEvalTrialSort, WorkspaceEvalTrialStatus } from '@kortix/sdk';
import { evalTrialScore } from '@kortix/sdk';
import { useWorkspaceEvalFilterValues, useWorkspaceEvalTrialsAcrossJobs } from '@kortix/sdk/react';
import { CaretLeftIcon, CaretRightIcon, ListBulletsIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { LocalTime } from '../../primitives/local-time';
import { PageSearchBar } from '../../primitives/page-search-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { Skeleton } from '../../primitives/skeleton';
import { StatusBadge } from '../../primitives/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { UiLink as Link, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { agentLabel, evalJobHref, trialTone, type CellTone } from './eval-meta';
import { EVAL_TIME, InfoHint, ListFooter } from './eval-ui';

const ANY = '__any__';
const PAGE_SIZE = 50;
const SORTS: WorkspaceEvalTrialSort[] = ['-created_at', 'created_at', '-finished_at', '-reward', 'reward', 'task'];
const TONE = { pass: 'success', fail: 'destructive', error: 'warning', running: 'info', queued: 'neutral', paused: 'warning', cancelled: 'neutral' } as const satisfies Record<CellTone, string>;

type Facet = 'status' | 'task' | 'agent' | 'model' | 'exception_type' | 'job';

/**
 * Customize → Evals → Trials: every trial of every job in one list, Harbor's
 * global rollout view. The filters run on the server and each lists its
 * values with counts in the scope of the others, so "every timeout of one
 * model" or "the errored runs of one task across jobs" is two clicks. A row
 * opens the trial beside its job.
 */
export function EvalTrialsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const params = useUiSearchParams();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Record<Facet, string>>({
    status: ANY,
    task: ANY,
    agent: ANY,
    model: ANY,
    exception_type: ANY,
    job: params.get('job') ?? ANY,
  });
  const [sort, setSort] = useState<WorkspaceEvalTrialSort>('-created_at');
  // The tokens of the pages before this one: Previous pops the last.
  const [tokens, setTokens] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo<WorkspaceEvalTrialFilters>(() => {
    const one = (facet: Facet) => (picked[facet] === ANY ? undefined : [picked[facet]]);
    return {
      job_ids: one('job'),
      status: one('status') as WorkspaceEvalTrialStatus[] | undefined,
      task: one('task'),
      agent: one('agent'),
      model: one('model'),
      exception_type: one('exception_type'),
      ...(q ? { q } : {}),
    };
  }, [picked, q]);
  const filterKey = JSON.stringify([filters, sort]);
  // A new filter or sort starts again at the first page.
  useEffect(() => setTokens([]), [filterKey]);
  const token = tokens[tokens.length - 1];
  const page = useWorkspaceEvalTrialsAcrossJobs(projectId, { ...filters, sort, page_size: PAGE_SIZE, page_token: token });
  const trials = page.data?.trials ?? [];
  const total = page.data?.total ?? 0;
  const first = tokens.length * PAGE_SIZE;
  const filtered = Object.values(picked).some((value) => value !== ANY) || !!q;
  const set = (facet: Facet) => (value: string) => setPicked((current) => ({ ...current, [facet]: value }));

  return (
    <CapabilityPageShell
      title={t('trialsTitle')}
      description={t('trialsDescription')}
      titleAddon={<InfoHint text={t('trialsInfo')} />}
      search={<PageSearchBar value={search} onChange={setSearch} placeholder={t('searchTrials')} />}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="evals-trial-filters">
          <FacetSelect projectId={projectId} facet="status" filters={filters} value={picked.status} onChange={set('status')} width="w-36" />
          <FacetSelect projectId={projectId} facet="job" filters={filters} value={picked.job} onChange={set('job')} width="w-48" />
          <FacetSelect projectId={projectId} facet="task" filters={filters} value={picked.task} onChange={set('task')} width="w-44" />
          <FacetSelect projectId={projectId} facet="agent" filters={filters} value={picked.agent} onChange={set('agent')} width="w-36" />
          <FacetSelect projectId={projectId} facet="model" filters={filters} value={picked.model} onChange={set('model')} width="w-44" />
          <FacetSelect projectId={projectId} facet="exception_type" filters={filters} value={picked.exception_type} onChange={set('exception_type')} width="w-44" />
          <Select value={sort} onValueChange={(value) => setSort(value as WorkspaceEvalTrialSort)}>
            <SelectTrigger size="sm" className="w-40" aria-label={t('sortLabel')} data-testid="evals-trials-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`trialSort.${value.replace('-', 'desc_')}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered || search ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setPicked({ status: ANY, task: ANY, agent: ANY, model: ANY, exception_type: ANY, job: ANY });
              }}
            >
              {t('clearFilters')}
            </Button>
          ) : null}
        </div>
        {page.isError ? (
          <ErrorState
            size="sm"
            title={t('loadError')}
            action={
              <Button size="sm" variant="outline" onClick={() => page.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : page.isLoading ? (
          <div className="flex flex-col gap-2" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : trials.length === 0 ? (
          <EmptyState
            size="sm"
            media={<ListBulletsIcon className="text-muted-foreground size-6" />}
            title={filtered ? t('noTrialMatch') : t('noTrialsYet')}
          />
        ) : (
          <>
            <Table data-testid="evals-all-trials">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colTask')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('colJob')}</TableHead>
                  <TableHead>{t('colResult')}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t('colReward')}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t('colFinished')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trials.map((trial) => (
                  <TrialRow key={trial.trial_id} projectId={projectId} trial={trial} onOpen={(href) => router.push(href)} />
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between gap-2">
              <ListFooter>{t('displayingRange', { from: first + 1, to: first + trials.length, total })}</ListFooter>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('previousPage')}
                  disabled={tokens.length === 0 || page.isFetching}
                  onClick={() => setTokens((current) => current.slice(0, -1))}
                  data-testid="evals-trials-prev"
                >
                  <CaretLeftIcon className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('nextPage')}
                  disabled={!page.data?.next_page_token || page.isFetching}
                  onClick={() => page.data?.next_page_token && setTokens((current) => [...current, page.data!.next_page_token!])}
                  data-testid="evals-trials-next"
                >
                  <CaretRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </CapabilityPageShell>
  );
}

/** One filter: its values in the scope of the other filters, each with how many trials have it. */
function FacetSelect({
  projectId,
  facet,
  filters,
  value,
  onChange,
  width,
}: {
  projectId: string;
  facet: Facet;
  filters: WorkspaceEvalTrialFilters;
  value: string;
  onChange: (value: string) => void;
  width: string;
}) {
  const t = useTranslations('evals');
  const values = useWorkspaceEvalFilterValues(projectId, 'trials', facet, filters);
  const options = values.data?.values ?? [];
  const label = (option: { value: string; label: string | null }) =>
    facet === 'status' ? t(`trialStatus.${option.value}`) : (option.label ?? option.value);
  // The picked value stays listed while the scope narrows around it.
  const listed = value !== ANY && !options.some((option) => option.value === value) ? [{ value, label: null, count: 0 }, ...options] : options;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={width} aria-label={t(`trialFacet.${facet}`)} data-testid={`evals-trials-facet-${facet}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{t(`trialFacetAny.${facet}`)}</SelectItem>
        {listed.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex w-full min-w-0 items-center justify-between gap-3">
              <span className="truncate">{label(option)}</span>
              <span className="text-muted-foreground text-xs tabular-nums">{option.count}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TrialRow({ projectId, trial, onOpen }: { projectId: string; trial: WorkspaceEvalTrialListItem; onOpen: (href: string) => void }) {
  const t = useTranslations('evals');
  const href = evalJobHref(projectId, trial.job_id, trial.trial_id);
  const tone = trialTone(trial);
  const { score } = evalTrialScore(trial);
  return (
    <TableRow className="hover:bg-hover cursor-pointer" onClick={() => onOpen(href)} data-testid="evals-trial-row">
      <TableCell className="max-w-72">
        <Link href={href} className="text-foreground block truncate font-mono text-sm" onClick={(e) => e.stopPropagation()}>
          {trial.task_name}
        </Link>
        <span className="text-muted-foreground block truncate text-xs">
          {[t('attempt', { n: trial.attempt }), trial.retry ? t('retryN', { n: trial.retry }) : null, agentLabel(trial.agent, trial.model)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground hidden max-w-44 truncate text-sm md:table-cell">{trial.job_name}</TableCell>
      <TableCell className="max-w-52">
        <span className="flex min-w-0 items-center gap-2">
          <StatusBadge tone={TONE[tone]}>{t(`tone.${tone}`)}</StatusBadge>
          {trial.exception ? (
            <span className="text-muted-foreground truncate font-mono text-xs" title={trial.exception.exception_message}>
              {trial.exception.exception_type}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-right font-mono text-xs tabular-nums sm:table-cell">
        {score === null ? '—' : score.toFixed(2)}
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-right text-xs whitespace-nowrap lg:table-cell">
        {trial.finished_at ? <LocalTime value={trial.finished_at} options={EVAL_TIME} /> : '—'}
      </TableCell>
    </TableRow>
  );
}
