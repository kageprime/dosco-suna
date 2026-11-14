/**
 * Evals (project flag `evals`): run agents on a list of tasks and score them.
 *
 * Kortix runs the Harbor task format (https://harborframework.com): a TASK is
 * an instruction, a sandbox and `tests/test.sh`, which writes the reward to
 * `/logs/verifier/reward.json` (named numbers) or `reward.txt` (one number). A
 * TRIAL is one agent's attempt at one task. A JOB is tasks × agents × attempts.
 * A SUITE is a job config under `evals:` in kortix.yaml, in the field names of
 * a Harbor job config, or `config: <path>` to a Harbor job config file.
 *
 * The API owns every rule (`/v1/workspaces/:workspaceId/evals/*`). The wire
 * types mirror `@kortix/api-contract` evals.ts; this package does not import it.
 */

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type WorkspaceEvalJobStatus = 'queued' | 'running' | 'completed' | 'cancelled';
export type WorkspaceEvalTrialStatus = 'queued' | 'starting' | 'agent_running' | 'verifying' | 'completed' | 'errored' | 'cancelled';

export interface WorkspaceEvalAgentConfig {
  name: string;
  model_name?: string | null;
  override_timeout_sec?: number | null;
  max_timeout_sec?: number | null;
}

export interface WorkspaceEvalTaskSource {
  /** A repository path: one task folder, or a folder of task folders. */
  path?: string | null;
  /** A dataset of the Harbor registry, such as `terminal-bench`. */
  name?: string | null;
  version?: string | null;
  /** A public git repository (https); `path` is inside it. */
  git_url?: string | null;
  /** The commit, branch or tag of `git_url`. */
  git_commit_id?: string | null;
  task_names?: string[] | null;
  exclude_task_names?: string[] | null;
  n_tasks?: number | null;
}

/** A job config in Harbor's job config field names. */
export interface WorkspaceEvalJobConfig {
  job_name?: string | null;
  n_attempts: number;
  n_concurrent_trials: number;
  timeout_multiplier: number;
  agent_timeout_multiplier?: number | null;
  verifier_timeout_multiplier?: number | null;
  retry: { max_retries: number; include_exceptions?: string[] | null; exclude_exceptions?: string[] | null };
  override_error_policy: Record<string, Partial<WorkspaceEvalErrorPolicy>>;
  agents: WorkspaceEvalAgentConfig[];
  tasks: WorkspaceEvalTaskSource[];
  datasets: WorkspaceEvalTaskSource[];
  metrics: Array<{ type: 'mean' | 'sum' | 'min' | 'max' }>;
  environment: { sandbox?: string | null; delete: boolean };
  verifier: { disable: boolean; env: Record<string, string> };
}

export interface WorkspaceEvalErrorPolicy {
  should_retry: boolean;
  should_grade: boolean;
  has_valid_reward: boolean;
}

export interface WorkspaceEvalException {
  exception_type: string;
  exception_message: string;
  occurred_at: string;
  policy: WorkspaceEvalErrorPolicy;
}

export interface WorkspaceEvalTiming {
  started_at: string | null;
  finished_at: string | null;
}

/** The score of one agent × model over the tasks of one source of the job (Harbor's grouping). */
export interface WorkspaceEvalAgentStats {
  agent: string;
  model: string | null;
  /** The dataset (`name@version`) or task path; null for a job with one source. */
  source: string | null;
  /** Trials whose reward counts. */
  n_trials: number;
  n_errors: number;
  /** One entry per metric of the job: `{ mean: 0.5 }`, or one value per reward key. */
  metrics: Array<Record<string, number>>;
  /**
   * `k` → Harbor's unbiased pass@k, averaged over tasks. Only when every
   * reward value is 0 or 1 (a trial passes when all its keys are 1); empty
   * for graded rewards.
   */
  pass_at_k: Record<string, number>;
}

/** Token use and gateway cost. */
export interface WorkspaceEvalUsage {
  n_input_tokens: number;
  n_output_tokens: number;
  /** Cache reads and cache writes. */
  n_cache_tokens: number;
  /** USD; null when the gateway recorded no cost. */
  cost_usd: number | null;
}

export interface WorkspaceEvalJobStats {
  n_total_trials: number;
  n_queued: number;
  n_running: number;
  n_completed: number;
  n_errored: number;
  n_cancelled: number;
  /** Runs superseded by a retry (not in `n_total_trials`). */
  n_retries: number;
  /** Exception type → trials that ended with it. */
  exception_stats: Record<string, number>;
  /** Token use and cost of every trial so far. */
  usage: WorkspaceEvalUsage | null;
  agents: WorkspaceEvalAgentStats[];
}

export interface WorkspaceEvalJob {
  job_id: string;
  project_id: string;
  suite: string | null;
  job_name: string;
  status: WorkspaceEvalJobStatus;
  /** The commit the tasks and the config were read at. */
  commit: string | null;
  ref: string | null;
  config: WorkspaceEvalJobConfig;
  stats: WorkspaceEvalJobStats;
  rerun_of: string | null;
  /** The job's folder in Files. */
  folder: string;
  drive_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkspaceEvalTrial {
  trial_id: string;
  job_id: string;
  trial_name: string;
  task_name: string;
  task_path: string;
  /** Opens the task: `getWorkspaceEvalTask(projectId, task_id)`. */
  task_id: string | null;
  agent: string;
  model: string | null;
  attempt: number;
  retry: number;
  status: WorkspaceEvalTrialStatus;
  session_id: string | null;
  rewards: Record<string, number> | null;
  reward_valid: boolean;
  exception: WorkspaceEvalException | null;
  environment_setup: WorkspaceEvalTiming;
  agent_execution: WorkspaceEvalTiming;
  verifier: WorkspaceEvalTiming;
  /** Token use of the trial's session; refreshed while the agent runs. */
  usage: WorkspaceEvalUsage | null;
  folder: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkspaceEvalSuite {
  name: string;
  source: 'inline' | 'config';
  config_path: string | null;
  /** Null when the suite does not resolve; `error` says why. */
  config: WorkspaceEvalJobConfig | null;
  error: string | null;
  warnings: string[];
  last_job: WorkspaceEvalJob | null;
}

export interface WorkspaceEvalTask {
  /** Opaque id of the task at one commit: `getWorkspaceEvalTask` reads it. */
  task_id: string;
  name: string;
  path: string;
  instruction: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
  has_solution: boolean;
  environment: string | null;
  metadata: Record<string, unknown>;
  /** Why Kortix cannot run this task, or null. */
  unsupported: string | null;
  /** From `[metadata]` of task.toml. */
  category: string | null;
  difficulty: string | null;
  tags: string[];
}

export interface WorkspaceEvalTaskDetail {
  task: WorkspaceEvalTask;
  /** The task folder's README.md, or null. */
  readme: string | null;
  task_toml: string | null;
  /** Every file of the task folder, paths relative to it. */
  files: Array<{ path: string; size: number }>;
}

/** The last run of one attempt of a task in some job. */
export interface WorkspaceEvalTaskResult {
  job_id: string;
  job_name: string;
  trial_id: string;
  agent: string;
  model: string | null;
  attempt: number;
  status: WorkspaceEvalTrialStatus;
  rewards: Record<string, number> | null;
  reward_valid: boolean;
  exception_type: string | null;
  finished_at: string | null;
}

export interface WorkspaceEvalTrialDetail {
  trial: WorkspaceEvalTrial;
  instruction: string | null;
  files: Array<{ path: string; size: number }>;
}

/** One agent × model on one task, over every ended attempt. */
export interface WorkspaceEvalTaskResultSummary {
  agent: string;
  model: string | null;
  /** Ended attempts whose reward counts. */
  n: number;
  n_passed: number;
  mean_reward: number | null;
}

/** A dataset a job names by `name` and `version`: built-in (`kortix/…`) or Harbor registry. */
export interface WorkspaceEvalDataset {
  name: string;
  /** The version a job without one runs. */
  version: string;
  /** Every version, newest first. */
  versions: string[];
  kind: 'builtin' | 'registry';
  description: string;
  /** Null when not known without reading the dataset. */
  n_tasks: number | null;
}

/** What `planWorkspaceEvalJob` says a job would run. */
export interface WorkspaceEvalJobPlan {
  commit: string;
  n_tasks: number;
  n_trials: number;
  agents: Array<{ name: string; model: string | null }>;
  /** The first 200 task names. */
  tasks: string[];
  warnings: string[];
}

export interface WorkspaceEvalCompareCell {
  job_id: string;
  n: number;
  n_passed: number;
  pass_rate: number | null;
  mean_reward: number | null;
  exception_type: string | null;
}

export interface WorkspaceEvalCompareRow {
  task_name: string;
  /** Set when the compare is `by: 'task_agent_model'`. */
  agent: string | null;
  model: string | null;
  /** One per job, in the order of `jobs`. */
  cells: WorkspaceEvalCompareCell[];
  /** The last job against the first. */
  change: 'better' | 'worse' | 'same' | 'only_one';
}

export interface WorkspaceEvalCompare {
  jobs: WorkspaceEvalJob[];
  by: 'task' | 'task_agent_model';
  rows: WorkspaceEvalCompareRow[];
  summary: { better: number; worse: number; same: number; only_one: number };
}

/** Filters of `listWorkspaceEvalJobs`. */
export interface WorkspaceEvalJobFilters {
  status?: WorkspaceEvalJobStatus;
  suite?: string;
  /** A dataset name of the job's config, such as `kortix/my-kortix`. */
  dataset?: string;
  agent?: string;
  model?: string;
  /** Part of the job name. */
  q?: string;
}

export interface StartWorkspaceEvalJobInput {
  /** A suite of `evals:`. `config` overrides its fields, or is the whole config without one. */
  suite?: string;
  config?: Partial<WorkspaceEvalJobConfig>;
  /** Branch or commit the tasks are read at. */
  ref?: string;
}

/** Retries of a POST with the same key return the job the first one created. */
export interface WorkspaceEvalRequestOptions {
  idempotencyKey?: string;
}

export interface RerunWorkspaceEvalJobInput {
  /** `failed`: reward below 1 or none. `errored`: ended with an exception. */
  scope?: 'all' | 'failed' | 'errored';
  trial_ids?: string[];
}

function segment(value: string, what: string): string {
  if (value === '.' || value === '..' || !value) {
    throw new Error(`Refused the ${what} "${value}": a "." or ".." segment would send the request to another endpoint. Pass ids exactly as Kortix prints them.`);
  }
  return encodeURIComponent(value);
}

const evalsPath = (projectId: string) => `/workspaces/${segment(projectId, 'workspace id')}/evals`;
const jobPath = (projectId: string, jobId: string) => `${evalsPath(projectId)}/jobs/${segment(jobId, 'job id')}`;
const trialPath = (projectId: string, jobId: string, trialId: string) => `${jobPath(projectId, jobId)}/trials/${segment(trialId, 'trial id')}`;

function query(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
}

/** The suites of `evals:` at `ref` (default: the default branch), each with its latest job. */
export async function listWorkspaceEvalSuites(projectId: string, options?: { ref?: string }): Promise<WorkspaceEvalSuite[]> {
  return unwrap(await backendApi.get<{ suites: WorkspaceEvalSuite[] }>(`${evalsPath(projectId)}${query({ ref: options?.ref })}`), 'Eval suites request failed').suites;
}

/**
 * The tasks a suite selects, the tasks under a repository path, or the tasks
 * of a dataset by name (built-in `kortix/…` or the Harbor registry), with the
 * dataset's README.
 */
export async function listWorkspaceEvalTasks(
  projectId: string,
  options: { suite?: string; path?: string; dataset?: string; version?: string | null; ref?: string },
): Promise<{ commit: string | null; tasks: WorkspaceEvalTask[]; readme: string | null }> {
  return unwrap(
    await backendApi.get<{ commit: string | null; tasks: WorkspaceEvalTask[]; readme: string | null }>(`${evalsPath(projectId)}/tasks${query(options)}`),
    'Eval tasks request failed',
  );
}

/** One task by its `task_id`: the parsed task, its README, task.toml and its files. */
export async function getWorkspaceEvalTask(projectId: string, taskId: string): Promise<WorkspaceEvalTaskDetail> {
  return unwrap(await backendApi.get<WorkspaceEvalTaskDetail>(`${evalsPath(projectId)}/tasks/${segment(taskId, 'task id')}`), 'Eval task request failed');
}

/** A body read as text: the API serves eval files as `text/plain`, and a `.json` file stays as written. */
const asText = (data: unknown): string => (typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/** One file of a task folder, as text (the first 1 MB). */
export async function readWorkspaceEvalTaskFile(projectId: string, taskId: string, path: string): Promise<string> {
  return asText(unwrap(await backendApi.get<unknown>(`${evalsPath(projectId)}/tasks/${segment(taskId, 'task id')}/file${query({ path })}`), 'Eval task file request failed'));
}

/** The last run of each attempt of a task across the project's jobs, newest first, with one summary per agent × model. */
export async function listWorkspaceEvalTaskResults(
  projectId: string,
  taskId: string,
): Promise<{ results: WorkspaceEvalTaskResult[]; summary: WorkspaceEvalTaskResultSummary[] }> {
  return unwrap(
    await backendApi.get<{ results: WorkspaceEvalTaskResult[]; summary: WorkspaceEvalTaskResultSummary[] }>(`${evalsPath(projectId)}/tasks/${segment(taskId, 'task id')}/results`),
    'Eval task results request failed',
  );
}

/** The datasets a job can name: built-in (`kortix/…`) first, then the Harbor registry. `registry_error` says why the registry is missing. */
export async function listWorkspaceEvalDatasets(projectId: string): Promise<{ datasets: WorkspaceEvalDataset[]; registry_error: string | null }> {
  return unwrap(await backendApi.get<{ datasets: WorkspaceEvalDataset[]; registry_error: string | null }>(`${evalsPath(projectId)}/datasets`), 'Eval datasets request failed');
}

/** Jobs, newest first. Pass `next_cursor` back as `cursor` for the next page; `total` counts every page. */
export async function listWorkspaceEvalJobs(
  projectId: string,
  options?: WorkspaceEvalJobFilters & { limit?: number; cursor?: string },
): Promise<{ jobs: WorkspaceEvalJob[]; next_cursor: string | null; total: number }> {
  const { status, suite, dataset, agent, model, q, limit, cursor } = options ?? {};
  return unwrap(
    await backendApi.get<{ jobs: WorkspaceEvalJob[]; next_cursor: string | null; total: number }>(
      `${evalsPath(projectId)}/jobs${query({ status, suite, dataset, agent, model, q, limit, cursor })}`,
    ),
    'Eval jobs request failed',
  );
}

const idempotency = (options?: WorkspaceEvalRequestOptions) => (options?.idempotencyKey ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {});

/**
 * Plan and queue a job. Throws `ApiError` 422 (`eval_invalid`, with
 * `violations`) when the config does not resolve. With an `idempotencyKey`, a
 * retry returns the job the first request created.
 */
export async function startWorkspaceEvalJob(projectId: string, input: StartWorkspaceEvalJobInput, options?: WorkspaceEvalRequestOptions): Promise<WorkspaceEvalJob> {
  // No host error toast: every caller shows the refusal itself (the CLI prints it, the Run modal keeps it inline).
  return unwrap(
    await backendApi.post<{ job: WorkspaceEvalJob }>(`${evalsPath(projectId)}/jobs`, { ...input, dry_run: undefined }, { showErrors: false, ...idempotency(options) }),
    'Eval job start failed',
  ).job;
}

/** What a job would run (tasks, trials, agents, warnings), with nothing created. Throws like `startWorkspaceEvalJob`. */
export async function planWorkspaceEvalJob(projectId: string, input: StartWorkspaceEvalJobInput): Promise<WorkspaceEvalJobPlan> {
  return unwrap(await backendApi.post<WorkspaceEvalJobPlan>(`${evalsPath(projectId)}/jobs`, { ...input, dry_run: true }, { showErrors: false }), 'Eval job plan failed');
}

/**
 * Two or more jobs task by task: one row per task (or per task × agent × model
 * with `by: 'task_agent_model'`), and what changed from the first job to the
 * last.
 */
export async function compareWorkspaceEvalJobs(projectId: string, jobIds: string[], options?: { by?: 'task' | 'task_agent_model' }): Promise<WorkspaceEvalCompare> {
  return unwrap(
    await backendApi.get<WorkspaceEvalCompare>(`${evalsPath(projectId)}/compare${query({ jobs: jobIds.map((id) => segment(id, 'job id')).join(','), by: options?.by })}`),
    'Eval compare request failed',
  );
}

export async function getWorkspaceEvalJob(projectId: string, jobId: string): Promise<WorkspaceEvalJob> {
  return unwrap(await backendApi.get<{ job: WorkspaceEvalJob }>(jobPath(projectId, jobId)), 'Eval job request failed').job;
}

export async function listWorkspaceEvalTrials(projectId: string, jobId: string): Promise<WorkspaceEvalTrial[]> {
  return unwrap(await backendApi.get<{ trials: WorkspaceEvalTrial[] }>(`${jobPath(projectId, jobId)}/trials`), 'Eval trials request failed').trials;
}

export async function getWorkspaceEvalTrial(projectId: string, jobId: string, trialId: string): Promise<WorkspaceEvalTrialDetail> {
  return unwrap(await backendApi.get<WorkspaceEvalTrialDetail>(trialPath(projectId, jobId, trialId)), 'Eval trial request failed');
}

/** One file of a trial's folder, as text (`result.json`, `verifier/test-stdout.txt`, …). */
export async function readWorkspaceEvalTrialFile(projectId: string, jobId: string, trialId: string, path: string): Promise<string> {
  return asText(unwrap(await backendApi.get<unknown>(`${trialPath(projectId, jobId, trialId)}/file${query({ path })}`), 'Eval trial file request failed'));
}

/** A new job that runs trials of an ended job again, at the same commit and config. A running job throws `ApiError` 409. */
export async function rerunWorkspaceEvalJob(projectId: string, jobId: string, input: RerunWorkspaceEvalJobInput = {}, options?: WorkspaceEvalRequestOptions): Promise<WorkspaceEvalJob> {
  return unwrap(await backendApi.post<{ job: WorkspaceEvalJob }>(`${jobPath(projectId, jobId)}/rerun`, input, idempotency(options)), 'Eval job rerun failed').job;
}

/**
 * Run one ended trial again inside its job: a new run of the same attempt
 * (`retry` + 1) that supersedes it, and the job runs until it ends.
 */
export async function retryWorkspaceEvalTrial(projectId: string, jobId: string, trialId: string, options?: WorkspaceEvalRequestOptions): Promise<WorkspaceEvalTrial> {
  return unwrap(await backendApi.post<{ trial: WorkspaceEvalTrial }>(`${trialPath(projectId, jobId, trialId)}/retry`, {}, idempotency(options)), 'Eval trial retry failed').trial;
}

/** Cancel one queued or running trial; its sandbox stops. The rest of the job runs on. */
export async function cancelWorkspaceEvalTrial(projectId: string, jobId: string, trialId: string): Promise<WorkspaceEvalTrial> {
  return unwrap(await backendApi.post<{ trial: WorkspaceEvalTrial }>(`${trialPath(projectId, jobId, trialId)}/cancel`, {}), 'Eval trial cancel failed').trial;
}

/** No queued trial starts; every running trial ends `cancelled` with its sandbox stopped. */
export async function cancelWorkspaceEvalJob(projectId: string, jobId: string): Promise<WorkspaceEvalJob> {
  return unwrap(await backendApi.post<{ job: WorkspaceEvalJob }>(`${jobPath(projectId, jobId)}/cancel`, {}), 'Eval job cancel failed').job;
}

/** Delete an ended job and its folder in Files. A running job throws `ApiError` 409. */
export async function deleteWorkspaceEvalJob(projectId: string, jobId: string): Promise<void> {
  unwrap(await backendApi.delete<{ ok: true }>(jobPath(projectId, jobId)), 'Eval job delete failed');
}

// ── Scores ───────────────────────────────────────────────────────────────────

/**
 * One trial in two numbers. `passed`: every reward is 1 or more (Harbor's
 * pass). `score`: the mean of its rewards. Both count only a valid reward.
 */
export function evalTrialScore(trial: Pick<WorkspaceEvalTrial, 'rewards' | 'reward_valid'>): { passed: boolean; score: number | null } {
  const values = trial.reward_valid ? Object.values(trial.rewards ?? {}) : [];
  if (values.length === 0) return { passed: false, score: null };
  return { passed: values.every((value) => value >= 1), score: values.reduce((a, b) => a + b, 0) / values.length };
}

export interface WorkspaceEvalJobScore {
  agent: string;
  model: string | null;
  /** Share of tasks the agent passed on its first attempt. */
  passAt1: number | null;
  /** The job's first metric, when it has one value. */
  metric: { name: string; value: number } | null;
  /** The mean of the first metric's values over every reward key: the headline when there is no pass@1. */
  mean: number | null;
  validTrials: number;
  errors: number;
}

/**
 * A job's headline: the agent × model (and source) with the highest pass@1,
 * else the highest first metric (a job with graded, non-binary rewards has no
 * pass@k). Null before any trial counts.
 */
export function evalJobScore(job: Pick<WorkspaceEvalJob, 'stats'>): WorkspaceEvalJobScore | null {
  const mean = (stats: WorkspaceEvalAgentStats) => {
    const values = Object.values(stats.metrics[0] ?? {});
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const headline = (stats: WorkspaceEvalAgentStats) => stats.pass_at_k['1'] ?? mean(stats) ?? -1;
  const ranked = [...(job.stats.agents ?? [])].sort((a, b) => headline(b) - headline(a));
  const best = ranked[0];
  if (!best) return null;
  const first = best.metrics[0] ?? {};
  const keys = Object.keys(first);
  return {
    agent: best.agent,
    model: best.model,
    passAt1: best.pass_at_k['1'] ?? null,
    metric: keys.length === 1 ? { name: keys[0]!, value: first[keys[0]!]! } : null,
    mean: mean(best),
    validTrials: best.n_trials,
    errors: best.n_errors,
  };
}
