'use client';

import type { WorkspaceEvalTaskResult } from '@kortix/sdk';
import {
  useVisibleAgents,
  useWorkspaceEvalSuites,
  useWorkspaceEvalTask,
  useWorkspaceEvalTaskFile,
  useWorkspaceEvalTaskResults,
} from '@kortix/sdk/react';
import { PlayIcon, TextAlignLeftIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { UnifiedMarkdown } from '../../markdown';
import { HighlightedCode } from '../../markdown/code';
import { CopyButton } from '../../markdown/copy-button';
import { Alert, AlertDescription, AlertTitle } from '../../primitives/alert';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { FileTree, FileTreeNav } from '../../primitives/file-tree';
import { Hint } from '../../primitives/hint';
import { LocalTime } from '../../primitives/local-time';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Tag } from '../../primitives/tag';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';
import { isMarkdownPath, languageForPath } from '../shared/entity/entity-files';
import { isNoFileAccess } from './eval-dataset-view';
import {
  agentLabel,
  datasetLabel,
  evalDatasetHref,
  evalJobHref,
  evalTasksHref,
  evalTrialScore,
  percent,
  runCommand,
  type CellTone,
  type EvalDatasetRef,
} from './eval-meta';
import {
  EVAL_FRAME,
  EVAL_TIME,
  EvalDetailPage,
  EvalTitle,
  RunCommand,
  SectionTitle,
  ShareButton,
  useUrlTab,
} from './eval-ui';
import { RunEvalModal } from './run-eval-modal';

const TABS = ['instruction', 'readme', 'files', 'results'] as const;
type Tab = (typeof TABS)[number];

/** `1.2 KB`: a file size. */
const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`;

/** A result's tone, as a trial cell reads it. */
function resultTone(result: WorkspaceEvalTaskResult): CellTone {
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'queued') return 'queued';
  if (result.status === 'starting' || result.status === 'agent_running' || result.status === 'verifying') return 'running';
  const { passed, score } = evalTrialScore(result);
  if (score === null) return result.exception_type ? 'error' : 'fail';
  return passed ? 'pass' : 'fail';
}

const TONE_BADGE = {
  pass: 'success',
  fail: 'destructive',
  error: 'warning',
  running: 'info',
  queued: 'neutral',
  cancelled: 'neutral',
} as const;

/**
 * Customize → Evals → Tasks → one task (`/admin/eval-tasks/<task_id>`), the
 * Harbor Hub's task page: the name and tags, New job on this task alone, the
 * CLI command, then Instruction, README, Files (a tree and the file) and
 * Results (every run of this task here, per agent × model).
 */
export function EvalTaskView({
  projectId,
  taskId,
  from,
}: {
  projectId: string;
  taskId: string;
  /** The dataset the task was opened from: the breadcrumb and New job name it. */
  from: EvalDatasetRef | null;
}) {
  const t = useTranslations('evals');
  const detail = useWorkspaceEvalTask(projectId, taskId);
  const results = useWorkspaceEvalTaskResults(projectId, taskId);
  const suites = useWorkspaceEvalSuites(from?.kind === 'suite' ? projectId : null);
  const agents = useVisibleAgents({ projectId });
  const [running, setRunning] = useState(false);
  const task = detail.data?.task;
  const readme = detail.data?.readme ?? null;
  const tabs = TABS.filter((tab) => tab !== 'readme' || !!readme);
  const [tab, setTab] = useUrlTab<Tab>(tabs);
  const firstAgent = agents.find((agent) => agent.name !== 'kortix')?.name ?? null;
  const notFound = detail.isError && (detail.error as { status?: number } | null)?.status === 404;

  const crumbs = [
    { label: t('tasksTitle'), href: evalTasksHref(projectId) },
    ...(from ? [{ label: datasetLabel(from), href: evalDatasetHref(projectId, from, 'tasks') }] : []),
    { label: task?.name ?? '…' },
  ];

  return (
    <EvalDetailPage crumbs={crumbs}>
      {from && task ? (
        <RunEvalModal
          projectId={projectId}
          suites={suites.data ?? []}
          target={{ ...from, tasks: [task.name] }}
          open={running}
          onOpenChange={setRunning}
        />
      ) : null}
      {notFound ? (
        <EmptyState
          size="sm"
          title={t('taskNotFound')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href={evalTasksHref(projectId)}>{t('tasksTitle')}</Link>
            </Button>
          }
        />
      ) : detail.isError ? (
        <ErrorState
          size="sm"
          title={isNoFileAccess(detail.error) ? t('noFileAccess') : t('loadError')}
          description={isNoFileAccess(detail.error) ? t('noFileAccessDescription') : undefined}
          action={
            isNoFileAccess(detail.error) ? undefined : (
              <Button size="sm" variant="outline" onClick={() => detail.refetch()}>
                {t('retry')}
              </Button>
            )
          }
        />
      ) : !task ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-96" />
          <Skeleton className="h-60 w-full rounded-md" />
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <EvalTitle
              name={task.name}
              description={
                <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {[task.category, task.difficulty, ...task.tags]
                    .filter((value): value is string => !!value)
                    .map((value) => (
                      <Tag key={value}>{value}</Tag>
                    ))}
                </span>
              }
            />
            <div className="flex flex-wrap items-center gap-2">
              <ShareButton />
              {from ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={!!task.unsupported}
                  onClick={() => setRunning(true)}
                  data-testid="evals-task-run"
                >
                  <PlayIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
                  {t('runThisTask')}
                </Button>
              ) : null}
            </div>
          </header>
          {task.unsupported ? (
            <Alert>
              <AlertTitle>{t('unsupported')}</AlertTitle>
              <AlertDescription>{task.unsupported}</AlertDescription>
            </Alert>
          ) : null}
          {from ? <RunCommand command={runCommand(from, { agent: firstAgent, task: task.name })} /> : null}
          <dl
            className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4"
            data-testid="evals-task-facts"
          >
            <Fact label={t('agentTimeout')} value={`${task.agent_timeout_sec} s`} />
            <Fact label={t('verifierTimeout')} value={`${task.verifier_timeout_sec} s`} />
            <Fact label={t('environment')} value={task.environment ?? t('defaultSandbox')} mono />
            <Fact label={t('solution')} value={task.has_solution ? t('yes') : t('no')} />
          </dl>
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList className="w-fit">
              {tabs.map((value) => (
                <TabsTrigger key={value} value={value} data-testid={`evals-tab-${value}`}>
                  {t(`taskTab.${value}`)}
                  {value === 'files' ? (
                    <span className="text-muted-foreground ml-1 tabular-nums">{detail.data!.files.length}</span>
                  ) : value === 'results' && results.data ? (
                    <span className="text-muted-foreground ml-1 tabular-nums">{results.data.results.length}</span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="instruction" className="pt-4">
              <article className={`${EVAL_FRAME} px-6 py-5`} data-testid="evals-task-instruction">
                {/* A task's instruction is someone else's text: untrusted, no HTML, no remote images. */}
                <UnifiedMarkdown content={task.instruction} trust="untrusted" variant="document" />
              </article>
            </TabsContent>
            {readme ? (
              <TabsContent value="readme" className="pt-4">
                <article className={`${EVAL_FRAME} px-6 py-5`}>
                  <UnifiedMarkdown content={readme} trust="untrusted" variant="document" />
                </article>
              </TabsContent>
            ) : null}
            <TabsContent value="files" className="pt-4">
              <TaskFiles projectId={projectId} taskId={taskId} files={detail.data!.files} />
            </TabsContent>
            <TabsContent value="results" className="pt-4">
              <TaskResults projectId={projectId} query={results} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </EvalDetailPage>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt>{label}</dt>
      <dd className={cn('text-foreground truncate', mono && 'font-mono')} title={value}>
        {value}
      </dd>
    </div>
  );
}

/** The Hub's file browser: the folder's tree on the left, one file on the right with size, wrap and copy. */
function TaskFiles({
  projectId,
  taskId,
  files,
}: {
  projectId: string;
  taskId: string;
  files: Array<{ path: string; size: number }>;
}) {
  const t = useTranslations('evals');
  // Every file by its path, the folder's own files first (instruction.md, task.toml), then each folder's.
  const nodes = files
    .map((f) => f.path)
    .sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b))
    .map((path) => ({ path, name: path, depth: 0 }));
  const first = files.find((f) => f.path === 'instruction.md') ?? files.find((f) => f.path === 'tests/test.sh') ?? files[0];
  const [picked, setPicked] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const path = picked && files.some((f) => f.path === picked) ? picked : (first?.path ?? null);
  const file = useWorkspaceEvalTaskFile(projectId, taskId, path);
  const size = files.find((f) => f.path === path)?.size ?? null;
  if (files.length === 0) {
    return <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`}>{t('noFiles')}</div>;
  }
  return (
    <div className={cn(EVAL_FRAME, 'grid min-h-96 md:grid-cols-[minmax(12rem,16rem)_1fr]')} data-testid="evals-task-files">
      <div className="border-border overflow-y-auto border-b p-2 md:max-h-[36rem] md:border-r md:border-b-0">
        <FileTree title={<span className="text-xs">{t('filesCount', { count: files.length })}</span>}>
          <FileTreeNav nodes={nodes} selectedPath={path ?? undefined} onSelect={setPicked} label={t('files')} />
        </FileTree>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" data-testid="evals-file-path">
            {path}
          </span>
          {size !== null ? <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{bytes(size)}</span> : null}
          <Hint label={wrap ? t('noWrap') : t('wrap')}>
            <Button
              size="icon-sm"
              variant={wrap ? 'secondary' : 'ghost'}
              aria-label={wrap ? t('noWrap') : t('wrap')}
              aria-pressed={wrap}
              onClick={() => setWrap(!wrap)}
            >
              <TextAlignLeftIcon className="size-3.5" />
            </Button>
          </Hint>
          {file.data !== undefined ? <CopyButton code={file.data} label={t('copyFile')} size="sm" /> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto md:max-h-[33rem]">
          {file.isLoading ? (
            <div className="flex flex-col gap-2 p-4" aria-busy>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-4 w-9/12" />
            </div>
          ) : file.isError ? (
            <p className="text-muted-foreground p-4 text-sm">{t('fileLoadError')}</p>
          ) : path && isMarkdownPath(path) ? (
            <div className="px-5 py-4">
              <UnifiedMarkdown content={file.data ?? ''} trust="untrusted" variant="document" />
            </div>
          ) : (
            <pre
              className={cn(
                'text-foreground p-4 font-mono text-xs',
                wrap ? 'wrap-break-word whitespace-pre-wrap' : 'overflow-x-auto',
                '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
                '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent',
                wrap && '[&_code]:!whitespace-pre-wrap',
              )}
            >
              <HighlightedCode code={file.data ?? ''} language={languageForPath(path ?? '')} />
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Every run of this task here: one summary row per agent × model, then each run, newest first. */
function TaskResults({
  projectId,
  query,
}: {
  projectId: string;
  query: ReturnType<typeof useWorkspaceEvalTaskResults>;
}) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  if (query.isLoading) return <Skeleton className="h-40 w-full rounded-md" />;
  if (query.isError)
    return (
      <ErrorState
        size="sm"
        title={t('loadError')}
        action={
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  const { results = [], summary = [] } = query.data ?? {};
  if (results.length === 0)
    return (
      <div className={`${EVAL_FRAME} text-muted-foreground px-4 py-6 text-center text-sm`} data-testid="evals-task-no-results">
        {t('noTaskResults')}
      </div>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="evals-task-results">
      <section className="flex flex-col gap-3">
        <SectionTitle title={t('byAgent')} info={t('byAgentInfo')} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colAgent')}</TableHead>
              <TableHead className="text-right">{t('colPassRate')}</TableHead>
              <TableHead className="text-right">{t('colMeanReward')}</TableHead>
              <TableHead className="text-right">{t('colAttempts')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.map((row) => (
              <TableRow key={`${row.agent}-${row.model}`}>
                <TableCell className="max-w-64 truncate font-medium">{agentLabel(row.agent, row.model)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {row.n ? percent(row.n_passed / row.n) : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.mean_reward === null ? '—' : row.mean_reward.toFixed(2)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">{`${row.n_passed}/${row.n}`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle title={t('runs')} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('colJob')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('colAgent')}</TableHead>
              <TableHead>{t('colResult')}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t('colReward')}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t('colFinished')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result) => {
              const tone = resultTone(result);
              const href = evalJobHref(projectId, result.job_id, result.trial_id);
              return (
                <TableRow
                  key={result.trial_id}
                  className="hover:bg-hover cursor-pointer"
                  onClick={() => router.push(href)}
                  data-testid="evals-task-result-row"
                >
                  <TableCell className="max-w-64">
                    <Link href={href} className="text-foreground block truncate" onClick={(e) => e.stopPropagation()}>
                      {result.job_name}
                    </Link>
                    {result.attempt > 1 ? (
                      <span className="text-muted-foreground text-xs">{t('attempt', { n: result.attempt })}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-56 truncate sm:table-cell">
                    {agentLabel(result.agent, result.model)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={TONE_BADGE[tone]}>{t(`tone.${tone}`)}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right font-mono text-xs tabular-nums sm:table-cell">
                    {result.rewards
                      ? Object.entries(result.rewards)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(' · ')
                      : (result.exception_type ?? '—')}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-right md:table-cell">
                    {result.finished_at ? <LocalTime value={result.finished_at} options={EVAL_TIME} /> : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
