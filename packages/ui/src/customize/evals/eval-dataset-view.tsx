'use client';

import type { WorkspaceEvalTask } from '@kortix/sdk';
import {
  useVisibleAgents,
  useWorkspaceEvalDatasets,
  useWorkspaceEvalJobs,
  useWorkspaceEvalSuites,
  useWorkspaceEvalTasks,
} from '@kortix/sdk/react';
import { PlayIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { UnifiedMarkdown } from '../../markdown';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Tag } from '../../primitives/tag';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';
import {
  datasetLabel,
  evalDatasetHref,
  evalDatasetsHref,
  evalTaskHref,
  leaderboard,
  runCommand,
  type EvalDatasetRef,
} from './eval-meta';
import {
  EVAL_FRAME,
  EvalDetailPage,
  EvalTitle,
  JobsTable,
  LeaderboardTable,
  ListFooter,
  RunCommand,
  ShareButton,
  useUrlTab,
} from './eval-ui';
import { RunEvalModal } from './run-eval-modal';

const TABS = ['readme', 'tasks', 'leaderboard', 'jobs'] as const;
type Tab = (typeof TABS)[number];

/** `403` from a task read: the caller may not read the repository's files. */
export const isNoFileAccess = (error: unknown): boolean =>
  (error as { status?: number } | null)?.status === 403;

/**
 * Customize → Evals → Datasets → one dataset (`/admin/eval-datasets/<kind>/<name>`),
 * the Harbor Hub's dataset page: the name, New job, the CLI command, a version
 * select, then README, Tasks, Leaderboard (this dataset's agents × models) and
 * Jobs. A tab with nothing in it is left out.
 */
export function EvalDatasetView({ projectId, dataset }: { projectId: string; dataset: EvalDatasetRef }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const suites = useWorkspaceEvalSuites(projectId);
  const catalog = useWorkspaceEvalDatasets(dataset.kind === 'dataset' ? projectId : null);
  const agents = useVisibleAgents({ projectId });
  const tasks = useWorkspaceEvalTasks(
    projectId,
    dataset.kind === 'suite' ? { suite: dataset.name } : { dataset: dataset.name, version: dataset.version },
  );
  const jobs = useWorkspaceEvalJobs(
    projectId,
    dataset.kind === 'suite' ? { suite: dataset.name } : { dataset: dataset.name },
  );
  const [running, setRunning] = useState(false);

  const suite = dataset.kind === 'suite' ? suites.data?.find((s) => s.name === dataset.name) : undefined;
  const meta =
    dataset.kind === 'dataset' ? catalog.data?.datasets.find((d) => d.name === dataset.name) : undefined;
  const version = dataset.kind === 'dataset' ? (dataset.version ?? meta?.version ?? null) : null;
  const ref: EvalDatasetRef = dataset.kind === 'dataset' ? { ...dataset, version } : dataset;
  const jobList = jobs.data ?? [];
  // A dataset's jobs can name several versions: the board keeps this one's.
  const board = leaderboard(
    version ? jobList.filter((job) => !job.config.datasets.some((d) => d.version && d.version !== version)) : jobList,
  );
  const readme = tasks.data?.readme ?? null;
  const tabs = TABS.filter(
    (tab) =>
      (tab !== 'readme' || !!readme) &&
      (tab !== 'leaderboard' || board.length > 0) &&
      (tab !== 'jobs' || jobList.length > 0),
  );
  const [tab, setTab] = useUrlTab<Tab>(tabs);
  const firstAgent = suite ? null : (agents.find((agent) => agent.name !== 'kortix')?.name ?? null);
  const unknown =
    (dataset.kind === 'suite' && suites.isSuccess && !suite) ||
    (dataset.kind === 'dataset' && catalog.isSuccess && !meta && tasks.isError);

  const description =
    dataset.kind === 'suite'
      ? suite?.error
        ? `${t('suiteError')}: ${suite.error}`
        : suite?.source === 'config' && suite.config_path
          ? t('suiteFromConfig', { path: suite.config_path })
          : t('suiteInline')
      : (meta?.description ?? null);

  return (
    <EvalDetailPage
      crumbs={[{ label: t('datasetsTitle'), href: evalDatasetsHref(projectId) }, { label: dataset.name }]}
    >
      <RunEvalModal
        projectId={projectId}
        suites={suites.data ?? []}
        target={dataset.kind === 'suite' ? { kind: 'suite', name: dataset.name } : { kind: 'dataset', name: dataset.name, version }}
        open={running}
        onOpenChange={setRunning}
      />
      {unknown ? (
        <EmptyState
          size="sm"
          title={t('datasetNotFound')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href={evalDatasetsHref(projectId)}>{t('datasetsTitle')}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <EvalTitle
              name={dataset.name}
              badge={
                <Tag>
                  {t(`origin.${dataset.kind === 'suite' ? 'suite' : (meta?.kind ?? 'registry')}`)}
                </Tag>
              }
              description={description}
            />
            <div className="flex flex-wrap items-center gap-2">
              {meta && meta.versions.length > 1 ? (
                <Select
                  value={version ?? meta.version}
                  onValueChange={(next) =>
                    router.push(evalDatasetHref(projectId, { kind: 'dataset', name: dataset.name, version: next }))
                  }
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={t('version')} data-testid="evals-version">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {meta.versions.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v === meta.version ? t('versionLatest', { version: v }) : v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <ShareButton />
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setRunning(true)}
                disabled={dataset.kind === 'suite' && !suite?.config}
                data-testid="evals-dataset-run"
              >
                <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
                {t('newJob')}
              </Button>
            </div>
          </header>
          <RunCommand command={runCommand(ref, { agent: firstAgent })} />
          {tasks.isLoading ? (
            <div className="flex flex-col gap-2" aria-busy>
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-40 w-full rounded-md" />
            </div>
          ) : (
            <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
              <TabsList className="w-fit">
                {tabs.map((value) => (
                  <TabsTrigger key={value} value={value} data-testid={`evals-tab-${value}`}>
                    {t(`datasetTab.${value}`)}
                    {value === 'tasks' && tasks.data ? (
                      <span className="text-muted-foreground ml-1 tabular-nums">{tasks.data.tasks.length}</span>
                    ) : value === 'jobs' ? (
                      <span className="text-muted-foreground ml-1 tabular-nums">{jobs.total}</span>
                    ) : null}
                  </TabsTrigger>
                ))}
              </TabsList>
              {readme ? (
                <TabsContent value="readme" className="pt-4">
                  <article className={`${EVAL_FRAME} px-6 py-5`} data-testid="evals-readme">
                    {/* A dataset's README is someone else's text: untrusted, no HTML, no remote images. */}
                    <UnifiedMarkdown content={readme} trust="untrusted" variant="document" />
                  </article>
                </TabsContent>
              ) : null}
              <TabsContent value="tasks" className="pt-4">
                {tasks.isError ? (
                  <ErrorState
                    size="sm"
                    title={isNoFileAccess(tasks.error) ? t('noFileAccess') : t('tasksLoadError')}
                    description={
                      isNoFileAccess(tasks.error)
                        ? t('noFileAccessDescription')
                        : tasks.error instanceof Error
                          ? tasks.error.message
                          : undefined
                    }
                    action={
                      isNoFileAccess(tasks.error) ? undefined : (
                        <Button size="sm" variant="outline" onClick={() => tasks.refetch()}>
                          {t('retry')}
                        </Button>
                      )
                    }
                  />
                ) : (
                  <TaskTable projectId={projectId} dataset={ref} tasks={tasks.data?.tasks ?? []} />
                )}
              </TabsContent>
              {board.length ? (
                <TabsContent value="leaderboard" className="pt-4">
                  <LeaderboardTable projectId={projectId} rows={board} showDataset={false} />
                </TabsContent>
              ) : null}
              {jobList.length ? (
                <TabsContent value="jobs" className="flex flex-col gap-3 pt-4">
                  <JobsTable projectId={projectId} jobs={jobList} showDataset={false} />
                  {jobs.total > jobList.length ? (
                    <ListFooter>{t('displayingJobs', { shown: jobList.length, total: jobs.total })}</ListFooter>
                  ) : null}
                </TabsContent>
              ) : null}
            </Tabs>
          )}
        </>
      )}
    </EvalDetailPage>
  );
}

/** The tasks of one dataset: searchable by name, category and tag; a row opens the task. */
export function TaskTable({
  projectId,
  dataset,
  tasks,
}: {
  projectId: string;
  dataset: EvalDatasetRef;
  tasks: WorkspaceEvalTask[];
}) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = tasks.filter(
    (task) =>
      !needle ||
      task.name.toLowerCase().includes(needle) ||
      (task.category ?? '').toLowerCase().includes(needle) ||
      task.tags.some((tag) => tag.toLowerCase().includes(needle)),
  );
  return (
    <div className="flex flex-col gap-3">
      <PageSearchBar value={search} onChange={setSearch} placeholder={t('searchTasks')} />
      {shown.length === 0 ? (
        <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`}>
          {needle ? t('noTaskMatch') : t('noTasks')}
        </div>
      ) : (
        <Table data-testid="evals-tasks">
          <TableHeader>
            <TableRow>
              <TableHead>{t('colTask')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('colCategory')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('colDifficulty')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('colTags')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((task) => {
              const href = evalTaskHref(projectId, task.task_id, dataset);
              return (
                <TableRow
                  key={task.task_id}
                  className="hover:bg-hover cursor-pointer"
                  onClick={() => router.push(href)}
                  data-testid="evals-task-row"
                >
                  <TableCell className="max-w-80">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link
                        href={href}
                        className="text-foreground truncate font-mono text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {task.name}
                      </Link>
                      {task.unsupported ? <Tag title={task.unsupported}>{t('unsupported')}</Tag> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                    {task.category ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
                    {task.difficulty ?? '—'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {task.tags.slice(0, 3).map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                      {task.tags.length > 3 ? (
                        <span className="text-muted-foreground text-xs">{`+${task.tags.length - 3}`}</span>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ListFooter>
        {t('displayingTasks', { shown: shown.length, total: tasks.length })}
        {dataset ? ` · ${datasetLabel(dataset)}` : ''}
      </ListFooter>
    </div>
  );
}
