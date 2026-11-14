'use client';

import type { WorkspaceEvalTask } from '@kortix/sdk';
import {
  useWorkspaceEvalDatasets,
  useWorkspaceEvalSuites,
  useWorkspaceEvalTaskCatalog,
  type WorkspaceEvalTaskSource,
} from '@kortix/sdk/react';
import { ListChecksIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
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
import { Tag } from '../../primitives/tag';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { isNoFileAccess } from './eval-dataset-view';
import {
  datasetKey,
  evalDatasetHref,
  evalDatasetsHref,
  evalTaskHref,
  type EvalDatasetRef,
} from './eval-meta';
import { InfoHint, ListFooter } from './eval-ui';

const ALL = '__all__';

/**
 * Customize → Evals → Tasks: every task of the suites of kortix.yaml and of
 * Kortix's built-in datasets, in one searchable table. A Harbor registry
 * dataset holds up to thousands of tasks: its tasks list on its own page.
 */
export function EvalTasksPage({ projectId }: { projectId: string }) {
  const t = useTranslations('evals');
  const router = useUiRouter();
  const suites = useWorkspaceEvalSuites(projectId);
  const datasets = useWorkspaceEvalDatasets(projectId);
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState(ALL);

  const refs = useMemo<EvalDatasetRef[]>(
    () => [
      ...(suites.data ?? []).filter((s) => s.config).map((s) => ({ kind: 'suite' as const, name: s.name })),
      ...(datasets.data?.datasets ?? [])
        .filter((d) => d.kind === 'builtin')
        .map((d) => ({ kind: 'dataset' as const, name: d.name, version: d.version })),
    ],
    [suites.data, datasets.data],
  );
  const sources = useMemo<WorkspaceEvalTaskSource[]>(
    () =>
      refs.map((ref) =>
        ref.kind === 'suite' ? { suite: ref.name } : { dataset: ref.name, version: ref.version ?? null },
      ),
    [refs],
  );
  const lists = useWorkspaceEvalTaskCatalog(projectId, sources);
  const rows = refs.flatMap((ref, i) =>
    (lists[i]?.data?.tasks ?? []).map((task) => ({ ref, task })),
  );
  const loading = suites.isLoading || datasets.isLoading || lists.some((list) => list.isLoading);
  const denied = lists.length > 0 && lists.every((list) => list.isError && isNoFileAccess(list.error));
  const needle = search.trim().toLowerCase();
  const shown = rows.filter(
    ({ ref, task }) =>
      (only === ALL || datasetKey(ref) === only) &&
      (!needle ||
        task.name.toLowerCase().includes(needle) ||
        ref.name.toLowerCase().includes(needle) ||
        (task.category ?? '').toLowerCase().includes(needle) ||
        task.tags.some((tag) => tag.toLowerCase().includes(needle))),
  );

  return (
    <CapabilityPageShell
      title={t('tasksTitle')}
      description={t('tasksDescription')}
      titleAddon={<InfoHint text={t('tasksInfo')} />}
      search={<PageSearchBar value={search} onChange={setSearch} placeholder={t('searchAllTasks')} />}
      filters={
        refs.length > 1 ? (
          <Select value={only} onValueChange={setOnly}>
            <SelectTrigger size="sm" className="w-52" aria-label={t('colDataset')} data-testid="evals-tasks-dataset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('allDatasets')}</SelectItem>
              {refs.map((ref) => (
                <SelectItem key={datasetKey(ref)} value={datasetKey(ref)}>
                  {ref.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : denied ? (
        <EmptyState
          size="sm"
          media={<ListChecksIcon className="text-muted-foreground size-6" />}
          title={t('noFileAccess')}
          description={t('noFileAccessDescription')}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          size="sm"
          media={<ListChecksIcon className="text-muted-foreground size-6" />}
          title={needle ? t('noTaskMatch') : t('noTasks')}
          description={needle ? undefined : t('noTasksHint')}
          action={
            needle ? (
              <Button size="sm" variant="outline" onClick={() => setSearch('')}>
                {t('clearSearch')}
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={evalDatasetsHref(projectId)}>{t('browseDatasets')}</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Table data-testid="evals-all-tasks">
            <TableHeader>
              <TableRow>
                <TableHead>{t('colTask')}</TableHead>
                <TableHead>{t('colDataset')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('colCategory')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('colDifficulty')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(({ ref, task }) => (
                <TaskRow key={`${datasetKey(ref)}-${task.task_id}`} projectId={projectId} dataset={ref} task={task} onOpen={(href) => router.push(href)} />
              ))}
            </TableBody>
          </Table>
          <ListFooter>
            {t('displayingTasks', { shown: shown.length, total: rows.length })}
            {` · ${t('registryTasksHint')}`}
          </ListFooter>
        </div>
      )}
    </CapabilityPageShell>
  );
}

function TaskRow({
  projectId,
  dataset,
  task,
  onOpen,
}: {
  projectId: string;
  dataset: EvalDatasetRef;
  task: WorkspaceEvalTask;
  onOpen: (href: string) => void;
}) {
  const t = useTranslations('evals');
  const href = evalTaskHref(projectId, task.task_id, dataset);
  return (
    <TableRow className="hover:bg-hover cursor-pointer" onClick={() => onOpen(href)} data-testid="evals-task-row">
      <TableCell className="max-w-80">
        <span className="flex min-w-0 items-center gap-2">
          <Link href={href} className="text-foreground truncate font-mono text-sm" onClick={(e) => e.stopPropagation()}>
            {task.name}
          </Link>
          {task.unsupported ? <Tag title={task.unsupported}>{t('unsupported')}</Tag> : null}
        </span>
      </TableCell>
      <TableCell className="max-w-48 truncate">
        <Link
          href={evalDatasetHref(projectId, dataset)}
          className="text-muted-foreground hover:text-foreground font-mono text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {dataset.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground hidden text-sm md:table-cell">{task.category ?? '—'}</TableCell>
      <TableCell className="text-muted-foreground hidden text-sm lg:table-cell">{task.difficulty ?? '—'}</TableCell>
    </TableRow>
  );
}
