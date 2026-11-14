'use client';

import type { WorkspaceEvalJob } from '@kortix/sdk';
import {
  useWorkspaceEvalDatasets,
  useWorkspaceEvalJobs,
  useWorkspaceEvalSuites,
  useWorkspaceEvalTasks,
} from '@kortix/sdk/react';
import { DatabaseIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Alert, AlertDescription } from '../../primitives/alert';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { PageSearchBar } from '../../primitives/page-search-bar';
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
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import {
  datasetKey,
  evalDatasetHref,
  evalJobScore,
  jobDataset,
  type EvalDatasetRef,
} from './eval-meta';
import { InfoHint, ListFooter, ScoreValue } from './eval-ui';

export type DatasetOrigin = 'suite' | 'builtin' | 'registry';

export interface DatasetRow {
  ref: EvalDatasetRef;
  origin: DatasetOrigin;
  description: string;
  /** Null: unknown without reading the dataset (a suite reads its own count). */
  nTasks: number | null;
  error: string | null;
}

const FILTERS = ['all', 'suite', 'builtin', 'registry'] as const;
type Filter = (typeof FILTERS)[number];

/** The newest completed job of each dataset, and how many jobs each has. */
export function jobsByDataset(jobs: WorkspaceEvalJob[]) {
  const latest = new Map<string, WorkspaceEvalJob>();
  const count = new Map<string, number>();
  for (const job of jobs) {
    const ref = jobDataset(job);
    if (!ref) continue;
    const key = datasetKey(ref);
    count.set(key, (count.get(key) ?? 0) + 1);
    if (job.status === 'completed' && !latest.has(key)) latest.set(key, job);
  }
  return { latest, count };
}

/**
 * Customize → Evals → Datasets: every dataset a job can run, in one table —
 * the suites of kortix.yaml, Kortix's built-in datasets and the Harbor
 * registry — with its task count and its latest score here. A row opens the
 * dataset (README, tasks, leaderboard, jobs).
 */
export function EvalDatasetsPage({ projectId }: { projectId: string }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const suites = useWorkspaceEvalSuites(projectId);
  const datasets = useWorkspaceEvalDatasets(projectId);
  const jobs = useWorkspaceEvalJobs(projectId);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo<DatasetRow[]>(
    () => [
      ...(suites.data ?? []).map((suite) => ({
        ref: { kind: 'suite' as const, name: suite.name },
        origin: 'suite' as const,
        description:
          suite.source === 'config' && suite.config_path
            ? suite.config_path
            : (suite.config?.agents ?? []).map((a) => a.name).join(', '),
        nTasks: null,
        error: suite.error,
      })),
      ...(datasets.data?.datasets ?? []).map((dataset) => ({
        ref: { kind: 'dataset' as const, name: dataset.name, version: dataset.version },
        origin: dataset.kind,
        description: dataset.description,
        nTasks: dataset.n_tasks,
        error: null,
      })),
    ],
    [suites.data, datasets.data],
  );
  const { latest, count } = jobsByDataset(jobs.data ?? []);
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (filter === 'all' || row.origin === filter) &&
      (!needle ||
        row.ref.name.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle)),
  );
  const loading = suites.isLoading || datasets.isLoading;
  const counts = (origin: Filter) =>
    origin === 'all' ? rows.length : rows.filter((row) => row.origin === origin).length;

  return (
    <CapabilityPageShell
      title={t('datasetsTitle')}
      description={t('datasetsDescription')}
      titleAddon={<InfoHint text={t('datasetsInfo')} />}
      search={
        <PageSearchBar
          value={search}
          onChange={setSearch}
          placeholder={t('searchDatasets')}
        />
      }
    >
      {suites.isError && datasets.isError ? (
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void Promise.all([suites.refetch(), datasets.refetch()])}
            >
              {t('retry')}
            </Button>
          }
        />
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <TabsList variant="segmented" className="w-fit" aria-label={t('datasetFilter')}>
              {FILTERS.map((value) => (
                <TabsTrigger key={value} value={value} data-testid={`evals-datasets-filter-${value}`}>
                  {t(`origin.${value}`)}
                  <span className="text-muted-foreground ml-1 tabular-nums">{counts(value)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {datasets.data?.registry_error ? (
            <Alert>
              <AlertDescription>
                {t('registryUnavailable', { reason: datasets.data.registry_error })}
              </AlertDescription>
            </Alert>
          ) : null}
          {shown.length === 0 ? (
            <EmptyState
              size="sm"
              media={<DatabaseIcon className="text-muted-foreground size-6" />}
              title={needle ? t('noDatasetMatch') : t('noDatasets')}
              action={
                needle ? (
                  <Button size="sm" variant="outline" onClick={() => setSearch('')}>
                    {t('clearSearch')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table data-testid="evals-datasets">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colDataset')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('colSource')}</TableHead>
                  <TableHead className="text-right">{t('colTaskCount')}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t('colLastScore')}</TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t('colJobs')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => {
                  const key = datasetKey(row.ref);
                  const last = latest.get(key);
                  const score = last ? evalJobScore(last) : null;
                  const href = evalDatasetHref(projectId, row.ref);
                  return (
                    <TableRow
                      key={key}
                      className="hover:bg-hover cursor-pointer"
                      onClick={() => router.push(href)}
                      data-testid="evals-dataset-row"
                    >
                      <TableCell className="max-w-96">
                        <Link
                          href={href}
                          className="text-foreground block truncate font-mono text-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.ref.name}
                        </Link>
                        <span className="text-muted-foreground line-clamp-1 text-xs">
                          {row.error ? `${t('suiteError')}: ${row.error}` : row.description}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Tag>{t(`origin.${row.origin}`)}</Tag>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {row.origin === 'suite' ? (
                          <SuiteTaskCount projectId={projectId} suite={row.ref.name} />
                        ) : row.nTasks === null ? (
                          '—'
                        ) : (
                          row.nTasks.toLocaleString()
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right md:table-cell">
                        {score ? (
                          <ScoreValue
                            rate={score.passAt1 ?? score.mean}
                            n={score.validTrials}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-right tabular-nums md:table-cell">
                        {count.get(key) ?? 0}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <ListFooter>{t('displayingDatasets', { shown: shown.length, total: rows.length })}</ListFooter>
        </div>
      )}
    </CapabilityPageShell>
  );
}

/** A suite's task count, read from its task list (the same request its Tasks tab makes). */
function SuiteTaskCount({ projectId, suite }: { projectId: string; suite: string }) {
  const tasks = useWorkspaceEvalTasks(projectId, { suite });
  if (!tasks.data) return <>—</>;
  return <>{tasks.data.tasks.length.toLocaleString()}</>;
}
