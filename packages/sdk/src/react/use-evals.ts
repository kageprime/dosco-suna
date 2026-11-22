'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelWorkspaceEvalJob,
  cancelWorkspaceEvalTrial,
  compareWorkspaceEvalJobs,
  deleteWorkspaceEvalJob,
  getWorkspaceEvalJob,
  getWorkspaceEvalTask,
  getWorkspaceEvalTrial,
  listWorkspaceEvalDatasets,
  listWorkspaceEvalJobs,
  listWorkspaceEvalSuites,
  listWorkspaceEvalTaskResults,
  listWorkspaceEvalTasks,
  readWorkspaceEvalTaskFile,
  listWorkspaceEvalTrials,
  readWorkspaceEvalTrialFile,
  planWorkspaceEvalJob,
  rerunWorkspaceEvalJob,
  retryWorkspaceEvalTrial,
  startWorkspaceEvalJob,
  type RerunWorkspaceEvalJobInput,
  type WorkspaceEvalJobFilters,
  type StartWorkspaceEvalJobInput,
  type WorkspaceEvalJob,
  type WorkspaceEvalTrial,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const inventory = contract('inventory');

/** An idempotency key per call. Not a secret: it only tells the API that two POSTs are one request. */
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** A job that has not ended re-reads every 5 seconds; an ended one does not. */
const OPEN_JOB_MS = 5_000;
const isOpen = (job: Pick<WorkspaceEvalJob, 'status'> | undefined) => job?.status === 'queued' || job?.status === 'running';

/** The suites of `evals:` in kortix.yaml, each with its latest job. Pass `null` while the `evals` flag is off. */
export function useWorkspaceEvalSuites(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.evals(projectId ?? ''),
    queryFn: () => listWorkspaceEvalSuites(projectId as string),
    enabled: !!projectId,
    ...inventory,
  });
}

/**
 * The datasets a job can name: Kortix's built-in datasets (`kortix/…`) first,
 * then the Harbor registry. The list changes with a release, so it is read once
 * per mount.
 */
export function useWorkspaceEvalDatasets(projectId: string | null | undefined) {
  return useQuery({
    queryKey: [...qk.project.evals(projectId ?? ''), 'datasets'] as const,
    queryFn: () => listWorkspaceEvalDatasets(projectId as string),
    enabled: !!projectId,
    ...inventory,
    staleTime: 10 * 60_000,
  });
}

/** Where a task list comes from: a suite of kortix.yaml, or a dataset by name (built-in `kortix/…` or Harbor registry). */
export type WorkspaceEvalTaskSource = { suite: string } | { dataset: string; version?: string | null };

const sourceKey = (source: WorkspaceEvalTaskSource) => ('suite' in source ? `suite:${source.suite}` : `dataset:${source.dataset}@${source.version ?? ''}`);

/**
 * The tasks of a suite or a dataset, parsed, with the dataset README. A
 * registry dataset reads its git repository on first use, so the list is kept
 * 10 minutes.
 */
export function useWorkspaceEvalTasks(projectId: string | null | undefined, source: WorkspaceEvalTaskSource | null | undefined) {
  const key = source ? sourceKey(source) : '';
  return useQuery({
    queryKey: qk.project.evalTasks(projectId ?? '', key),
    queryFn: () =>
      listWorkspaceEvalTasks(
        projectId as string,
        'suite' in source! ? { suite: source.suite } : { dataset: source!.dataset, version: source!.version ?? undefined },
      ),
    enabled: !!projectId && !!source,
    ...inventory,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * The tasks of several suites and datasets at once, each list cached as
 * `useWorkspaceEvalTasks` caches it. `results[i]` answers `sources[i]`; a
 * source that fails (no file access, a dataset that does not resolve) carries
 * its error and the rest still load.
 */
export function useWorkspaceEvalTaskCatalog(projectId: string | null | undefined, sources: WorkspaceEvalTaskSource[]) {
  return useQueries({
    queries: sources.map((source) => ({
      queryKey: qk.project.evalTasks(projectId ?? '', sourceKey(source)),
      queryFn: () => listWorkspaceEvalTasks(projectId as string, 'suite' in source ? { suite: source.suite } : { dataset: source.dataset, version: source.version ?? undefined }),
      enabled: !!projectId,
      ...inventory,
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
}

/** One task by its `task_id`. */
export function useWorkspaceEvalTask(projectId: string | null | undefined, taskId: string | null | undefined) {
  return useQuery({
    queryKey: [...qk.project.evals(projectId ?? ''), 'task', taskId ?? ''] as const,
    queryFn: () => getWorkspaceEvalTask(projectId as string, taskId as string),
    enabled: !!projectId && !!taskId,
    ...inventory,
    staleTime: 10 * 60_000,
  });
}

/** One file of a task folder, as text. */
export function useWorkspaceEvalTaskFile(projectId: string | null | undefined, taskId: string | null | undefined, path: string | null | undefined) {
  return useQuery({
    queryKey: [...qk.project.evals(projectId ?? ''), 'task', taskId ?? '', 'file', path ?? ''] as const,
    queryFn: () => readWorkspaceEvalTaskFile(projectId as string, taskId as string, path as string),
    enabled: !!projectId && !!taskId && !!path,
    ...inventory,
    staleTime: 10 * 60_000,
  });
}

/** The last run of each attempt of a task across the project's jobs, with a summary per agent × model. */
export function useWorkspaceEvalTaskResults(projectId: string | null | undefined, taskId: string | null | undefined) {
  return useQuery({
    queryKey: [...qk.project.evals(projectId ?? ''), 'task', taskId ?? '', 'results'] as const,
    queryFn: () => listWorkspaceEvalTaskResults(projectId as string, taskId as string),
    enabled: !!projectId && !!taskId,
    ...inventory,
  });
}

/**
 * The newest 100 jobs that match `filters` (a suite name for one suite, or
 * none for all). `total` counts every match. Re-reads every 5 seconds while
 * one of them runs.
 */
export function useWorkspaceEvalJobs(projectId: string | null | undefined, filters?: string | null | WorkspaceEvalJobFilters) {
  const where: WorkspaceEvalJobFilters = typeof filters === 'string' ? { suite: filters } : (filters ?? {});
  const key = JSON.stringify(Object.entries(where).filter(([, v]) => v !== undefined && v !== null && v !== '').sort());
  const query = useQuery({
    queryKey: qk.project.evalJobs(projectId ?? '', key),
    queryFn: () => listWorkspaceEvalJobs(projectId as string, { ...where, limit: 100 }),
    enabled: !!projectId,
    ...inventory,
    refetchInterval: (q) => ((q.state.data as { jobs: WorkspaceEvalJob[] } | undefined)?.jobs.some(isOpen) ? OPEN_JOB_MS : false),
  });
  return { ...query, data: query.data?.jobs, total: query.data?.total ?? 0 };
}

/** Jobs side by side, task by task. Pass two or more job ids, first the baseline. Re-reads while one of them runs. */
export function useWorkspaceEvalCompare(projectId: string | null | undefined, jobIds: string[] | null | undefined, by?: 'task' | 'task_agent_model') {
  return useQuery({
    queryKey: [...qk.project.evals(projectId ?? ''), 'compare', (jobIds ?? []).join(','), by ?? ''] as const,
    queryFn: () => compareWorkspaceEvalJobs(projectId as string, jobIds as string[], { by }),
    enabled: !!projectId && (jobIds?.length ?? 0) >= 2,
    ...inventory,
    refetchInterval: (q) => ((q.state.data as { jobs: WorkspaceEvalJob[] } | undefined)?.jobs.some(isOpen) ? OPEN_JOB_MS : false),
  });
}

/** One job and its trials, read together. Re-reads every 5 seconds until the job ends. */
export function useWorkspaceEvalJob(projectId: string | null | undefined, jobId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.evalJob(projectId ?? '', jobId ?? ''),
    queryFn: async (): Promise<{ job: WorkspaceEvalJob; trials: WorkspaceEvalTrial[] }> => {
      const [job, trials] = await Promise.all([
        getWorkspaceEvalJob(projectId as string, jobId as string),
        listWorkspaceEvalTrials(projectId as string, jobId as string),
      ]);
      return { job, trials };
    },
    enabled: !!projectId && !!jobId,
    ...inventory,
    refetchInterval: (query) => (isOpen((query.state.data as { job: WorkspaceEvalJob } | undefined)?.job) ? OPEN_JOB_MS : false),
  });
}

/** One trial: its instruction and the files of its folder. */
export function useWorkspaceEvalTrial(projectId: string | null | undefined, jobId: string | null | undefined, trialId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.evalTrial(projectId ?? '', jobId ?? '', trialId ?? ''),
    queryFn: () => getWorkspaceEvalTrial(projectId as string, jobId as string, trialId as string),
    enabled: !!projectId && !!jobId && !!trialId,
    ...inventory,
  });
}

/** One file of a trial's folder, as text. */
export function useWorkspaceEvalTrialFile(projectId: string | null | undefined, jobId: string | null | undefined, trialId: string | null | undefined, path: string | null | undefined) {
  return useQuery({
    queryKey: [...qk.project.evalTrial(projectId ?? '', jobId ?? '', trialId ?? ''), 'file', path ?? ''] as const,
    queryFn: () => readWorkspaceEvalTrialFile(projectId as string, jobId as string, trialId as string, path as string),
    enabled: !!projectId && !!jobId && !!trialId && !!path,
    ...inventory,
  });
}

/** Start, re-run, cancel and delete jobs. Each refreshes every eval read of the project. */
export function useWorkspaceEvalActions(projectId: string | null | undefined) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: qk.project.evals(projectId ?? '') });
  const pid = () => {
    if (!projectId) throw new Error('No workspace.');
    return projectId;
  };
  return {
    // One idempotency key per mutation call: a network retry of the same POST returns the same job.
    start: useMutation({ mutationFn: (input: StartWorkspaceEvalJobInput) => startWorkspaceEvalJob(pid(), input, { idempotencyKey: newKey() }), onSuccess: refresh }),
    plan: useMutation({ mutationFn: (input: StartWorkspaceEvalJobInput) => planWorkspaceEvalJob(pid(), input) }),
    rerun: useMutation({ mutationFn: (input: { jobId: string } & RerunWorkspaceEvalJobInput) => rerunWorkspaceEvalJob(pid(), input.jobId, { scope: input.scope, trial_ids: input.trial_ids }, { idempotencyKey: newKey() }), onSuccess: refresh }),
    retryTrial: useMutation({ mutationFn: (input: { jobId: string; trialId: string }) => retryWorkspaceEvalTrial(pid(), input.jobId, input.trialId, { idempotencyKey: newKey() }), onSuccess: refresh }),
    cancelTrial: useMutation({ mutationFn: (input: { jobId: string; trialId: string }) => cancelWorkspaceEvalTrial(pid(), input.jobId, input.trialId), onSuccess: refresh }),
    cancel: useMutation({ mutationFn: (jobId: string) => cancelWorkspaceEvalJob(pid(), jobId), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (jobId: string) => deleteWorkspaceEvalJob(pid(), jobId), onSuccess: refresh }),
  };
}
