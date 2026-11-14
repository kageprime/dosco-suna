'use client';

import type { WorkspaceEvalJobFilters, WorkspaceEvalJobStatus } from '@kortix/sdk';
import { useWorkspaceEvalJobs, useWorkspaceEvalSuites } from '@kortix/sdk/react';
import { ArrowsLeftRightIcon, PlayCircleIcon, PlayIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { PageSearchBar } from '../../primitives/page-search-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { Skeleton } from '../../primitives/skeleton';
import { useUiRouter } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { datasetKey, datasetLabel, evalCompareHref, jobDataset, parseDatasetKey } from './eval-meta';
import { InfoHint, JobsTable, ListFooter } from './eval-ui';
import { RunEvalModal } from './run-eval-modal';

const ANY = '__any__';
const STATUSES: WorkspaceEvalJobStatus[] = ['running', 'queued', 'completed', 'cancelled'];

/** The newest jobs, searched by name, kept by status, dataset and agent; two or more selected compare. */
export function EvalJobsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const suites = useWorkspaceEvalSuites(projectId);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(ANY);
  const [dataset, setDataset] = useState(ANY);
  const [agent, setAgent] = useState(ANY);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  // The search reaches the API 300 ms after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const ref = dataset === ANY ? null : parseDatasetKey(dataset);
  const filters: WorkspaceEvalJobFilters = {
    ...(status !== ANY ? { status: status as WorkspaceEvalJobStatus } : {}),
    ...(ref?.kind === 'suite' ? { suite: ref.name } : ref ? { dataset: ref.name } : {}),
    ...(agent !== ANY ? { agent } : {}),
    ...(q ? { q } : {}),
  };
  const jobs = useWorkspaceEvalJobs(projectId, filters);
  // Every job of the project, unfiltered, names the choices of the dataset and agent filters.
  const everything = useWorkspaceEvalJobs(projectId);
  const all = everything.data ?? [];
  const datasets = [
    ...new Map(
      [
        ...(suites.data ?? []).map((s) => ({ kind: 'suite' as const, name: s.name })),
        ...all.map(jobDataset).filter((r): r is NonNullable<typeof r> => r !== null),
      ].map((r) => [datasetKey(r), r]),
    ).values(),
  ];
  const agents = [...new Set(all.flatMap((job) => job.config.agents.map((a) => a.name)))].sort();
  const list = jobs.data ?? [];
  const filtered = Object.keys(filters).length > 0;
  const toggle = (jobId: string, on: boolean) =>
    setSelected((current) => (on ? [...current.filter((id) => id !== jobId), jobId] : current.filter((id) => id !== jobId)));

  return (
    <CapabilityPageShell
      title={t('jobsTitle')}
      description={t('jobsDescription')}
      titleAddon={<InfoHint text={t('jobsInfo')} />}
      search={<PageSearchBar value={search} onChange={setSearch} placeholder={t('searchJobs')} />}
      action={
        selected.length >= 2 ? (
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => router.push(evalCompareHref(projectId, oldestFirst(selected, list)))}
            data-testid="evals-compare"
          >
            <ArrowsLeftRightIcon className="size-3.5" aria-hidden />
            {t('compareN', { count: selected.length })}
          </Button>
        ) : (
          <Button size="sm" className="gap-1.5" onClick={() => setRunning(true)} data-testid="evals-run">
            <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
            {t('newJob')}
          </Button>
        )
      }
    >
      <RunEvalModal
        projectId={projectId}
        suites={suites.data ?? []}
        target={null}
        open={running}
        onOpenChange={setRunning}
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="evals-job-filters">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger size="sm" className="w-36" aria-label={t('colStatus')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('anyStatus')}</SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`status.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={dataset} onValueChange={setDataset}>
            <SelectTrigger size="sm" className="w-48" aria-label={t('colDataset')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('allDatasets')}</SelectItem>
              {datasets.map((r) => (
                <SelectItem key={datasetKey(r)} value={datasetKey(r)}>
                  {datasetLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={agent} onValueChange={setAgent}>
            <SelectTrigger size="sm" className="w-40" aria-label={t('colAgent')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('anyAgent')}</SelectItem>
              {agents.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
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
                setStatus(ANY);
                setDataset(ANY);
                setAgent(ANY);
              }}
            >
              {t('clearFilters')}
            </Button>
          ) : null}
          {selected.length ? (
            <span className="text-muted-foreground ml-auto text-xs">
              {selected.length === 1 ? t('selectOneMore') : t('selectedN', { count: selected.length })}
              <Button size="xs" variant="ghost" className="ml-1" onClick={() => setSelected([])}>
                {t('clearSelection')}
              </Button>
            </span>
          ) : null}
        </div>
        {jobs.isError ? (
          <ErrorState
            size="sm"
            title={t('loadError')}
            action={
              <Button size="sm" variant="outline" onClick={() => jobs.refetch()}>
                {t('retry')}
              </Button>
            }
          />
        ) : jobs.isLoading ? (
          <div className="flex flex-col gap-2" aria-busy>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            size="sm"
            media={<PlayCircleIcon className="text-muted-foreground size-6" />}
            title={filtered ? t('noJobMatch') : t('noJobs')}
            action={
              filtered ? undefined : (
                <Button size="sm" onClick={() => setRunning(true)}>
                  {t('newJob')}
                </Button>
              )
            }
          />
        ) : (
          <>
            <JobsTable projectId={projectId} jobs={list} selected={new Set(selected)} onSelect={toggle} />
            <ListFooter>{t('displayingJobs', { shown: list.length, total: jobs.total })}</ListFooter>
          </>
        )}
      </div>
    </CapabilityPageShell>
  );
}

/** Compare reads the first job as the baseline: the oldest of the picked ones. */
function oldestFirst(ids: string[], jobs: Array<{ job_id: string; created_at: string }>): string[] {
  const at = new Map(jobs.map((job) => [job.job_id, Date.parse(job.created_at)]));
  return [...ids].sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
}
