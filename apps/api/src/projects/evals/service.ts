/**
 * Evals: what a person asks for. List the suites of kortix.yaml and their
 * tasks, start a job, cancel it, run trials again, delete it. The runner
 * (`runner.ts`) does the work of a job once it exists.
 */
import { createHash } from 'node:crypto';
import type {
  CreateEvalJobRequest,
  EvalCompareResponse,
  EvalJobConfig,
  EvalJobPlanResponse,
  EvalSuite,
  EvalTask,
  EvalTaskDetailResponse,
  EvalTaskResult,
  EvalTaskResultsResponse,
  EvalTrialDetailResponse,
  RerunEvalJobRequest,
} from '@kortix/api-contract';
import { isUuid } from '../../shared/validate';
import { resolveCommitSha } from '../git';
import { withProjectGitAuth } from '../lib/git';
import type { ProjectRow } from '../lib/serializers';
import { EvalConfigError, planTasks, planTrials, readManifestEvals, resolveSuite, unknownAgents, type PlannedTrial, type ResolvedSuite } from './config';
import { stopTrialSandbox, templateNeedFor } from './runner';
import { listTemplatesForProject } from '../../snapshots/templates';
import { redactedConfig, serializeJob, serializeTrial } from './serialize';
import { evalsDrive, jobFolder, json, listEvalFiles, removeEvalFolder, trialFolder, writeEvalFiles } from './storage';
import {
  cancelOpenTrials,
  cancelTrial,
  deleteJob,
  getJob,
  getTrial,
  insertJob,
  insertRetry,
  jobByIdempotencyKey,
  jobConfig,
  lastRunsOfTask,
  latestJobBySuite,
  listTrials,
  refreshJobStats,
  retryByIdempotencyKey,
  setJobStatus,
  type EvalJobRow,
  type EvalTrialRow,
  type StartedBy,
} from './store';
import { decodeTaskId, encodeTaskId } from './task-id';
import { builtinDatasetSource, gitTree, isBuiltinDataset, loadTask, projectTree, rememberBuiltinTaskCount, resolveGitRef, treeFor, type EvalTaskRef, type TaskTree } from './task-source';
import type { HarborTask } from './harbor-task';
import type { PlannedTask } from './config';

export class EvalNotFoundError extends Error {}
/** The caller lacks a capability the job needs beyond starting sessions. */
export class EvalForbiddenError extends Error {}
export class EvalConflictError extends Error {
  constructor(
    message: string,
    /** The job the conflict is about, when there is one (an idempotency key reused with another body). */
    readonly jobId: string | null = null,
  ) {
    super(message);
  }
}

/** A job or trial id that is no UUID names nothing: 404, never a database error. */
const checkedId = (id: string): string => {
  if (!isUuid(id)) throw new EvalNotFoundError();
  return id;
};

const commitOf = async (project: ProjectRow, ref?: string | null) => {
  const gitProject = await withProjectGitAuth(project);
  try {
    return { gitProject, commit: await resolveCommitSha(gitProject, ref ?? undefined) };
  } catch {
    throw new EvalConfigError([`The ref ${ref ?? gitProject.defaultBranch} does not resolve to a commit of this project's repository.`]);
  }
};

const metaString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const metaTags = (metadata: Record<string, unknown>): string[] => {
  const raw = metadata.tags ?? metadata.keywords;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 20) : [];
};

export const toWireTask = (projectId: string, planned: { name: string; ref: EvalTaskRef; task: HarborTask }, projectCommit: string): EvalTask => ({
  task_id: encodeTaskId(projectId, planned.ref, projectCommit),
  name: planned.name,
  path: planned.ref.kind === 'repo' ? planned.ref.path : `${planned.ref.git_url}@${planned.ref.commit.slice(0, 7)}:${planned.ref.path}`,
  instruction: planned.task.instruction,
  agent_timeout_sec: planned.task.agentTimeoutSec,
  verifier_timeout_sec: planned.task.verifierTimeoutSec,
  has_solution: planned.task.hasSolution,
  environment: planned.task.dockerImage ?? (planned.task.hasDockerfile ? 'environment/Dockerfile' : null),
  metadata: planned.task.metadata,
  unsupported: planned.task.unsupported,
  category: metaString(planned.task.metadata.category),
  difficulty: metaString(planned.task.metadata.difficulty),
  tags: metaTags(planned.task.metadata),
});

const README_BYTES = 200_000;

async function readText(tree: TaskTree, path: string, maxBytes = README_BYTES): Promise<string | null> {
  try {
    const bytes = await tree.read(path);
    return new TextDecoder().decode(bytes.subarray(0, maxBytes));
  } catch {
    return null;
  }
}

/** README.md at the root of a config's single task source: a repo folder, a git folder or a built-in dataset. */
async function sourceReadme(gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>, commit: string, config: EvalJobConfig): Promise<string | null> {
  const sources = [...config.tasks, ...config.datasets];
  if (sources.length !== 1) return null;
  const source = sources[0]!;
  const resolved = !source.git_url && source.name && isBuiltinDataset(source.name) ? { ...source, ...builtinDatasetSource(source.name, source.version) } : source;
  if (resolved.git_url) {
    const sha = await resolveGitRef(resolved.git_url, resolved.git_commit_id).catch(() => null);
    return sha ? readText(gitTree(resolved.git_url, sha), `${resolved.path ? `${resolved.path}/` : ''}README.md`) : null;
  }
  if (!resolved.path) return null;
  return readText(projectTree(gitProject, commit), `${resolved.path}/README.md`);
}

const toWireSuite = (suite: ResolvedSuite, lastJob: EvalJobRow | undefined): EvalSuite => ({
  name: suite.name,
  source: suite.source,
  config_path: suite.configPath,
  config: suite.config,
  error: suite.error,
  warnings: suite.warnings,
  last_job: lastJob ? serializeJob(lastJob) : null,
});

/** The suites of `evals:` at the tip of the default branch (or `ref`), each resolved. */
export async function listSuites(project: ProjectRow, ref?: string | null): Promise<EvalSuite[]> {
  const { gitProject, commit } = await commitOf(project, ref);
  const manifest = await readManifestEvals(gitProject, commit);
  const latest = await latestJobBySuite(project.projectId);
  const suites: EvalSuite[] = [];
  for (const declared of manifest.suites) {
    const resolved = await resolveSuite(gitProject, commit, declared);
    const unknown = resolved.config ? unknownAgents(resolved.config, manifest.agents) : [];
    if (unknown.length) resolved.warnings.push(`Not an agent of this project: ${unknown.join(', ')}.`);
    suites.push(toWireSuite(resolved, latest.get(declared.name)));
  }
  return suites;
}

async function resolveConfig(project: ProjectRow, input: { suite?: string; config?: Record<string, unknown>; ref?: string | null }) {
  const { gitProject, commit } = await commitOf(project, input.ref);
  const manifest = await readManifestEvals(gitProject, commit);
  let declared = input.suite ? manifest.suites.find((suite) => suite.name === input.suite) : undefined;
  if (input.suite && !declared) {
    const names = manifest.suites.map((suite) => suite.name);
    throw new EvalConfigError([`kortix.yaml has no eval suite named "${input.suite}" at ${commit.slice(0, 7)}.${names.length ? ` Suites: ${names.join(', ')}.` : ' It declares no `evals:` section.'}`]);
  }
  declared ??= { name: '', configPath: null, config: {}, issues: [] };
  const resolved = await resolveSuite(gitProject, commit, declared, input.config);
  if (!resolved.config) throw new EvalConfigError([resolved.error ?? 'The eval config is not valid.']);
  const unknown = unknownAgents(resolved.config, manifest.agents);
  if (unknown.length) throw new EvalConfigError([`Not an agent of this project: ${unknown.join(', ')}. Name an agent of kortix.yaml, \`oracle\` or \`nop\`.`]);
  return { gitProject, commit, config: resolved.config, warnings: resolved.warnings };
}

/** The tasks a suite (or an ad-hoc config) selects, parsed. */
/**
 * The tasks a suite selects, the tasks under a repository path, or the tasks
 * of a dataset by name (built-in `kortix/…` or Harbor registry), with the
 * dataset's README.
 */
export async function listTasks(
  project: ProjectRow,
  input: { suite?: string; path?: string; dataset?: string; version?: string | null; ref?: string | null },
): Promise<{ commit: string; tasks: EvalTask[]; readme: string | null }> {
  const override = input.path
    ? { tasks: [{ path: input.path }], datasets: [] }
    : input.dataset
      ? { tasks: [], datasets: [{ name: input.dataset, ...(input.version ? { version: input.version } : {}) }] }
      : null;
  const { gitProject, commit, config } = await resolveConfig(project, { suite: input.suite, ...(override ? { config: override } : {}), ref: input.ref });
  const [tasks, readme] = await Promise.all([planTasks(gitProject, commit, config), sourceReadme(gitProject, commit, config).catch(() => null)]);
  if (input.dataset && isBuiltinDataset(input.dataset)) rememberBuiltinTaskCount(input.dataset, input.version, tasks.length);
  return { commit, tasks: tasks.map((task) => toWireTask(project.projectId, task, commit)), readme };
}

const taskOf = (project: ProjectRow, taskId: string) => {
  const decoded = decodeTaskId(project.projectId, taskId);
  if (!decoded) throw new EvalNotFoundError();
  return decoded;
};

/** One task by its id: the parsed task, its README, task.toml and every file of its folder. */
export async function taskDetail(project: ProjectRow, taskId: string): Promise<EvalTaskDetailResponse> {
  const decoded = taskOf(project, taskId);
  const gitProject = await withProjectGitAuth(project);
  const tree = treeFor(gitProject, decoded.commit, decoded.ref);
  const prefix = decoded.ref.path ? `${decoded.ref.path}/` : '';
  const [task, listed] = await Promise.all([
    loadTask(tree, decoded.ref).catch((err) => {
      throw err instanceof Error && err.name === 'TaskLoadError' ? new EvalNotFoundError() : err;
    }),
    tree.listSized(decoded.ref.path),
  ]);
  const files = listed
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const [readme, taskToml] = await Promise.all([readText(tree, `${prefix}README.md`), readText(tree, `${prefix}task.toml`)]);
  return {
    task: toWireTask(project.projectId, { name: task.name, ref: decoded.ref, task }, decoded.commit),
    readme: files.some((f) => f.path === 'README.md') ? readme : null,
    task_toml: taskToml,
    files,
  };
}

const TASK_FILE_BYTES = 1_000_000;

/** One file of a task folder, as text (the first 1 MB). */
export async function taskFile(project: ProjectRow, taskId: string, path: string): Promise<string> {
  const decoded = taskOf(project, taskId);
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new EvalNotFoundError();
  const gitProject = await withProjectGitAuth(project);
  const text = await readText(treeFor(gitProject, decoded.commit, decoded.ref), `${decoded.ref.path ? `${decoded.ref.path}/` : ''}${path}`, TASK_FILE_BYTES);
  if (text === null) throw new EvalNotFoundError();
  return text;
}

const exceptionTypeOf = (trial: Pick<EvalTrialRow, 'exception'>): string | null => {
  const type = (trial.exception as { exception_type?: unknown } | null)?.exception_type;
  return typeof type === 'string' ? type : null;
};

const ENDED: ReadonlySet<string> = new Set(['completed', 'errored', 'cancelled']);

/** Every reward at 1 or above. */
const passes = (rewards: Record<string, number> | null): boolean => {
  const values = Object.values(rewards ?? {});
  return values.length > 0 && values.every((value) => value >= 1);
};

/** The first reward key (Harbor's single reward), 0 for a counted trial with none. */
/** One attempt's score: the mean of its reward keys (`evalTrialScore` in the SDK reads it the same way). A trial without a key scores 0. */
const meanReward = (rewards: Record<string, number> | null): number => {
  const values = Object.values(rewards ?? {});
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

/**
 * One task across the project's jobs: the last run of each attempt, newest
 * first (up to 200), and per agent × model the ended attempts whose reward
 * counts, how many passed and their mean reward. A task is its location, so
 * runs at other commits of the same folder count.
 */
export async function taskResults(project: ProjectRow, taskId: string, limit = 200): Promise<EvalTaskResultsResponse> {
  const { ref } = taskOf(project, taskId);
  const where = ref.kind === 'repo' ? { kind: 'repo', path: ref.path } : { kind: 'git', path: ref.path, git_url: ref.git_url };
  const rows = await lastRunsOfTask(project.projectId, where, limit);
  const results: EvalTaskResult[] = rows.map(({ trial, jobName }) => ({
    job_id: trial.jobId,
    job_name: jobName,
    trial_id: trial.trialId,
    agent: trial.agent,
    model: trial.model,
    attempt: trial.attempt,
    status: trial.status,
    rewards: trial.rewards ?? null,
    reward_valid: trial.rewardValid,
    exception_type: exceptionTypeOf(trial),
    finished_at: trial.finishedAt ? trial.finishedAt.toISOString() : null,
  }));
  const groups = new Map<string, EvalTaskResult[]>();
  for (const result of results) {
    if (!ENDED.has(result.status) || !result.reward_valid) continue;
    const key = `${result.agent}\u0000${result.model ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const summary = [...groups.values()].map((group) => ({
    agent: group[0]!.agent,
    model: group[0]!.model,
    n: group.length,
    n_passed: group.filter((result) => passes(result.rewards)).length,
    mean_reward: group.reduce((sum, result) => sum + meanReward(result.rewards), 0) / group.length,
  }));
  return { results, summary: summary.sort((a, b) => b.n_passed / b.n - a.n_passed / a.n || a.agent.localeCompare(b.agent)) };
}

const stamp = (now: Date): string => now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 100) || 'job';

/** Who sends a request and how, for the job row: the session create reads it back for every trial. */
export interface JobRequester {
  userId: string;
  startedBy: StartedBy;
  /** `Idempotency-Key` of the request, or null. */
  idempotencyKey: string | null;
}

/** A key replayed with another body is a conflict; with the same body it returns the first job. */
async function replayOf(project: ProjectRow, requester: JobRequester, requestHash: string): Promise<EvalJobRow | null> {
  if (!requester.idempotencyKey) return null;
  const existing = await jobByIdempotencyKey(project.projectId, requester.idempotencyKey);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) throw new EvalConflictError('This Idempotency-Key was used for another request.', existing.jobId);
  return existing;
}

/** A stable hash of a request body: the same fields in any order hash the same. */
export function requestHash(scope: string, body: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => [key, stable((value as Record<string, unknown>)[key])]))
        : value;
  return createHash('sha256').update(`${scope}\n${JSON.stringify(stable(body))}`).digest('hex');
}

async function insertNamedJob(
  project: ProjectRow,
  requester: JobRequester,
  input: { suite: string | null; baseName: string; commit: string; ref: string | null; config: EvalJobConfig; trials: PlannedTrial[]; rerunOf: string | null; requestHash: string },
): Promise<{ job: EvalJobRow; replayed: boolean }> {
  const drive = await evalsDrive(project.accountId, project.projectId);
  for (let n = 1; n <= 20; n += 1) {
    const jobName = n === 1 ? input.baseName : `${input.baseName}-${n}`;
    const inserted = await insertJob({
      projectId: project.projectId,
      accountId: project.accountId,
      suite: input.suite,
      jobName,
      commitSha: input.commit,
      ref: input.ref,
      config: { ...input.config, job_name: jobName },
      rerunOf: input.rerunOf,
      driveId: drive.driveId,
      folder: jobFolder(jobName),
      createdBy: requester.userId,
      startedBy: requester.startedBy,
      idempotencyKey: requester.idempotencyKey,
      requestHash: requester.idempotencyKey ? input.requestHash : null,
      trials: input.trials,
    });
    if (inserted.existing) {
      if (inserted.existing.requestHash !== input.requestHash) throw new EvalConflictError('This Idempotency-Key was used for another request.', inserted.existing.jobId);
      return { job: inserted.existing, replayed: true };
    }
    const job = inserted.job;
    if (!job) continue;
    await refreshJobStats(job);
    // The folder starts with the config, as a Harbor job directory does. A storage failure does not stop the job.
    await writeEvalFiles(drive, job.folder, [{ path: 'config.json', content: json({ ...redactedConfig(jobConfig(job)), commit: input.commit, suite: input.suite }) }]).catch(() => undefined);
    return { job: (await getJob(project.projectId, job.jobId)) ?? job, replayed: false };
  }
  throw new EvalConflictError('A job of this name exists. Set another `job_name`.');
}

/** What a request would run: the config at its commit, the tasks and the trials. Creates nothing. */
async function planRequest(project: ProjectRow, request: CreateEvalJobRequest) {
  const { gitProject, commit, config, warnings } = await resolveConfig(project, { suite: request.suite, config: request.config as Record<string, unknown> | undefined, ref: request.ref });
  const tasks: PlannedTask[] = await planTasks(gitProject, commit, config);
  return { commit, config, tasks, trials: planTrials(config, tasks), warnings };
}

/** `dry_run`: the plan of a job, as the API answers it. */
export async function planJob(project: ProjectRow, request: CreateEvalJobRequest): Promise<EvalJobPlanResponse> {
  const plan = await planRequest(project, request);
  const agents = [...new Map(plan.trials.map((trial) => [`${trial.agent}\u0000${trial.model ?? ''}`, { name: trial.agent, model: trial.model }])).values()];
  return { commit: plan.commit, n_tasks: plan.tasks.length, n_trials: plan.trials.length, agents, tasks: plan.tasks.slice(0, 200).map((task) => task.name), warnings: plan.warnings };
}

/**
 * Plan and queue a job. The runner starts its trials on its next tick. A
 * replayed `Idempotency-Key` returns the job the first request created.
 */
export async function createJob(project: ProjectRow, requester: JobRequester, request: CreateEvalJobRequest, now: Date = new Date()): Promise<{ job: EvalJobRow; replayed: boolean; warnings: string[] }> {
  const hash = requestHash('create', { ...request, dry_run: undefined });
  const replay = await replayOf(project, requester, hash);
  if (replay) return { job: replay, replayed: true, warnings: [] };
  const plan = await planRequest(project, request);
  await assertTemplatesAllowed(project, requester, plan.config, plan.tasks);
  const baseName = safeName(plan.config.job_name ?? `${request.suite ?? 'eval'}-${stamp(now)}`);
  const inserted = await insertNamedJob(project, requester, { suite: request.suite ?? null, baseName, commit: plan.commit, ref: request.ref ?? null, config: plan.config, trials: plan.trials, rerunOf: null, requestHash: hash });
  return { ...inserted, warnings: inserted.replayed ? [] : plan.warnings };
}

/**
 * A task with its own environment runs on a project sandbox template; the
 * runner makes a missing one. Making one is project infrastructure
 * (`project.sandbox.write`), so a caller without it may start only jobs whose
 * templates the project already has.
 */
async function assertTemplatesAllowed(project: ProjectRow, requester: JobRequester, config: EvalJobConfig, tasks: PlannedTask[]): Promise<void> {
  if (requester.startedBy.may_create_templates || config.environment.sandbox) return;
  const needed = new Map<string, string>();
  for (const planned of tasks) {
    const need = (() => {
      try {
        return templateNeedFor(planned.task, planned.ref);
      } catch {
        return null;
      }
    })();
    if (need) needed.set(need.slug, need.image ?? need.dockerfilePath ?? planned.name);
  }
  if (needed.size === 0) return;
  const have = new Set((await listTemplatesForProject(await withProjectGitAuth(project))).map((template) => template.slug));
  const missing = [...needed].filter(([slug]) => !have.has(slug)).map(([, what]) => what);
  if (missing.length) {
    throw new EvalForbiddenError(
      `These tasks need sandbox templates this workspace does not have yet (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). Making one needs project.sandbox.write: ask someone who has it to start the job once.`,
    );
  }
}

/** A reward below 1, or none. */
const failed = (trial: EvalTrialRow): boolean => {
  const values = Object.values(trial.rewards ?? {});
  return values.length === 0 || values.some((value) => value < 1);
};

/** The last run of each attempt stands for it. */
function lastRuns(trials: EvalTrialRow[]): EvalTrialRow[] {
  const last = new Map<string, EvalTrialRow>();
  for (const trial of trials) {
    const key = `${trial.taskName}\u0000${trial.agent}\u0000${trial.model ?? ''}\u0000${trial.attempt}`;
    if (!last.has(key) || last.get(key)!.retry < trial.retry) last.set(key, trial);
  }
  return [...last.values()];
}

/** A new job that runs trials of an ended job again, at the same commit and config. */
export async function rerunJob(project: ProjectRow, requester: JobRequester, jobId: string, request: RerunEvalJobRequest, now: Date = new Date()): Promise<{ job: EvalJobRow; replayed: boolean }> {
  const job = await getJob(project.projectId, checkedId(jobId));
  if (!job) throw new EvalNotFoundError();
  const hash = requestHash(`rerun:${job.jobId}`, request);
  const replay = await replayOf(project, requester, hash);
  if (replay) return { job: replay, replayed: true };
  if (job.status === 'queued' || job.status === 'running') {
    throw new EvalConflictError('The job is still running. Retry one trial inside it, or cancel it before you run it again.', job.jobId);
  }
  const all = await listTrials(job.jobId);
  const ids = request.trial_ids ? new Set(request.trial_ids) : null;
  const scope = request.scope ?? 'all';
  const baseName = (trial: EvalTrialRow) => trial.trialName.replace(/__r\d+$/, '');
  const picked = lastRuns(all).filter((trial) =>
    ids ? ids.has(trial.trialId) || all.some((other) => ids.has(other.trialId) && baseName(other) === baseName(trial)) : scope === 'all' ? true : scope === 'errored' ? trial.exception !== null : failed(trial),
  );
  if (picked.length === 0) throw new EvalConfigError(['No trial of this job matches. Nothing to run again.']);
  const trials: PlannedTrial[] = picked.map((trial) => ({
    trialName: baseName(trial),
    taskName: trial.taskName,
    taskRef: trial.taskRef as unknown as EvalTaskRef,
    agent: trial.agent,
    model: trial.model,
    attempt: trial.attempt,
  }));
  if (!job.commitSha) throw new EvalConfigError(['This job records no commit, so it cannot run again.']);
  return insertNamedJob(project, requester, {
    suite: job.suite,
    baseName: safeName(`${job.jobName.replace(/-rerun-\d{8}-\d{6}(-\d+)?$/, '')}-rerun-${stamp(now)}`),
    commit: job.commitSha,
    ref: job.ref,
    config: jobConfig(job),
    trials,
    rerunOf: job.jobId,
    requestHash: hash,
  });
}

async function jobAndTrial(project: ProjectRow, jobId: string, trialId: string): Promise<{ job: EvalJobRow; trial: EvalTrialRow }> {
  const job = await getJob(project.projectId, checkedId(jobId));
  const trial = job ? await getTrial(job.jobId, checkedId(trialId)) : null;
  if (!job || !trial) throw new EvalNotFoundError();
  return { job, trial };
}

/**
 * Run one ended trial again inside its job: a new run of its attempt
 * (`retry` + 1) that supersedes it. An ended job runs again until the new run
 * ends. The trial must be the last run of its attempt.
 */
export async function retryTrial(project: ProjectRow, jobId: string, trialId: string, idempotencyKey: string | null): Promise<{ trial: EvalTrialRow; replayed: boolean }> {
  const { job, trial } = await jobAndTrial(project, jobId, trialId);
  if (idempotencyKey) {
    const replay = await retryByIdempotencyKey(job.jobId, idempotencyKey);
    if (replay) return { trial: replay, replayed: true };
  }
  if (!ENDED.has(trial.status)) throw new EvalConflictError('The trial is still running. Cancel it first, or wait for it to end.', job.jobId);
  const later = (await listTrials(job.jobId)).some(
    (other) => other.taskName === trial.taskName && other.agent === trial.agent && other.model === trial.model && other.attempt === trial.attempt && other.retry > trial.retry,
  );
  if (later) throw new EvalConflictError('A later run of this attempt exists. Retry that run instead.', job.jobId);
  const run = await insertRetry(trial, idempotencyKey ? { idempotency_key: idempotencyKey } : {});
  if (!run) throw new EvalConflictError('A later run of this attempt exists. Retry that run instead.', job.jobId);
  // The job is open again: the runner starts the new run on its next tick.
  await setJobStatus(job.jobId, ['completed', 'cancelled'], { status: 'running', finishedAt: null });
  await refreshJobStats(job);
  return { trial: run, replayed: false };
}

/** Cancel one queued or running trial; its sandbox stops. The rest of the job runs on. */
export async function cancelOneTrial(project: ProjectRow, jobId: string, trialId: string): Promise<EvalTrialRow> {
  const { job, trial } = await jobAndTrial(project, jobId, trialId);
  if (ENDED.has(trial.status)) return trial;
  const cancelled = await cancelTrial(trial);
  if (!cancelled) return (await getTrial(job.jobId, trial.trialId)) ?? trial;
  if (cancelled.sessionId) await stopTrialSandbox(job, cancelled.sessionId);
  await refreshJobStats(job);
  return cancelled;
}

/** Cancel a job: no queued trial starts, and every running trial's sandbox stops. */
export async function cancelJob(project: ProjectRow, jobId: string, now: Date = new Date()): Promise<EvalJobRow> {
  const job = await getJob(project.projectId, checkedId(jobId));
  if (!job) throw new EvalNotFoundError();
  if (job.status === 'completed' || job.status === 'cancelled') return job;
  const cancelled = await cancelOpenTrials(job.jobId);
  await setJobStatus(job.jobId, ['queued', 'running'], { status: 'cancelled', finishedAt: now });
  await Promise.all(cancelled.filter((trial) => trial.sessionId).map((trial) => stopTrialSandbox(job, trial.sessionId!)));
  await refreshJobStats(job);
  return (await getJob(project.projectId, jobId)) ?? job;
}

/** Delete an ended job: its rows and its folder in Files. The trial sessions stay. */
export async function removeJob(project: ProjectRow, jobId: string): Promise<void> {
  const job = await getJob(project.projectId, checkedId(jobId));
  if (!job) throw new EvalNotFoundError();
  if (job.status === 'queued' || job.status === 'running') throw new EvalConflictError('Cancel the job before you delete it.', job.jobId);
  await deleteJob(project.projectId, jobId);
  await removeEvalFolder(job.driveId, job.folder);
}

/** A trial and its folder's files. `instruction` is the task's text, read from the repository only when `canReadRepo`. */
export async function trialDetail(project: ProjectRow, jobId: string, trialId: string, canReadRepo: boolean): Promise<EvalTrialDetailResponse> {
  const { job, trial } = await jobAndTrial(project, jobId, trialId);
  const ref = trial.taskRef as unknown as EvalTaskRef;
  const gitProject = await withProjectGitAuth(project);
  const [instruction, files] = await Promise.all([
    canReadRepo ? loadTask(treeFor(gitProject, job.commitSha ?? gitProject.defaultBranch, ref), ref).then((task) => task.instruction, () => null) : Promise.resolve(null),
    listEvalFiles(job.driveId, trialFolder(job.folder, trial.trialName)).catch(() => []),
  ]);
  return { trial: serializeTrial(job, trial), instruction, files };
}

/** The trial a file route names, checked; null when there is none. */
export async function trialOf(project: ProjectRow, jobId: string, trialId: string): Promise<{ job: EvalJobRow; trial: EvalTrialRow } | null> {
  if (!isUuid(jobId) || !isUuid(trialId)) return null;
  return jobAndTrial(project, jobId, trialId).catch(() => null);
}

// ── Compare ──────────────────────────────────────────────────────────────────

export const COMPARE_JOBS_MAX = 10;

type CompareCell = EvalCompareResponse['rows'][number]['cells'][number];

function cellOf(jobId: string, runs: EvalTrialRow[]): CompareCell {
  const counted = runs.filter((trial) => ENDED.has(trial.status) && trial.rewardValid);
  const types = new Map<string, number>();
  for (const trial of runs) {
    const type = exceptionTypeOf(trial);
    if (type) types.set(type, (types.get(type) ?? 0) + 1);
  }
  const nPassed = counted.filter((trial) => passes(trial.rewards ?? null)).length;
  return {
    job_id: jobId,
    n: counted.length,
    n_passed: nPassed,
    pass_rate: counted.length ? nPassed / counted.length : null,
    mean_reward: counted.length ? counted.reduce((sum, trial) => sum + meanReward(trial.rewards ?? null), 0) / counted.length : null,
    exception_type: [...types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

const EPSILON = 1e-9;

function changeOf(first: CompareCell, last: CompareCell): EvalCompareResponse['rows'][number]['change'] {
  if (first.pass_rate === null && last.pass_rate === null) return 'same';
  if (first.pass_rate === null || last.pass_rate === null) return 'only_one';
  const byPass = last.pass_rate - first.pass_rate;
  if (Math.abs(byPass) > EPSILON) return byPass > 0 ? 'better' : 'worse';
  const byReward = (last.mean_reward ?? 0) - (first.mean_reward ?? 0);
  if (Math.abs(byReward) > EPSILON) return byReward > 0 ? 'better' : 'worse';
  return 'same';
}

/**
 * Jobs side by side, task by task, from the last run of each attempt. `by`
 * defaults to `task` when every job ran one agent × model, else
 * `task_agent_model`. `change` compares the last job with the first.
 */
export async function compareJobs(project: ProjectRow, jobIds: string[], by?: 'task' | 'task_agent_model'): Promise<EvalCompareResponse> {
  if (jobIds.length < 2 || jobIds.length > COMPARE_JOBS_MAX) throw new EvalConfigError([`Name 2 to ${COMPARE_JOBS_MAX} jobs in \`jobs\`.`]);
  const loaded = await Promise.all(
    jobIds.map(async (jobId) => {
      const job = await getJob(project.projectId, checkedId(jobId));
      if (!job) throw new EvalNotFoundError();
      return { job, runs: lastRuns(await listTrials(job.jobId)) };
    }),
  );
  const mode = by ?? (loaded.every(({ runs }) => new Set(runs.map((trial) => `${trial.agent}\u0000${trial.model ?? ''}`)).size <= 1) ? 'task' : 'task_agent_model');
  const keyOf = (trial: EvalTrialRow) => (mode === 'task' ? trial.taskName : `${trial.taskName}\u0000${trial.agent}\u0000${trial.model ?? ''}`);
  const keys = new Map<string, EvalTrialRow>();
  for (const { runs } of loaded) for (const trial of runs) if (!keys.has(keyOf(trial))) keys.set(keyOf(trial), trial);
  const rows = [...keys.entries()]
    .map(([key, sample]) => {
      const cells = loaded.map(({ job, runs }) => cellOf(job.jobId, runs.filter((trial) => keyOf(trial) === key)));
      return {
        task_name: sample.taskName,
        agent: mode === 'task' ? null : sample.agent,
        model: mode === 'task' ? null : sample.model,
        cells,
        change: changeOf(cells[0]!, cells[cells.length - 1]!),
      };
    })
    .sort((a, b) => a.task_name.localeCompare(b.task_name) || (a.agent ?? '').localeCompare(b.agent ?? '') || (a.model ?? '').localeCompare(b.model ?? ''));
  const summary = { better: 0, worse: 0, same: 0, only_one: 0 };
  for (const row of rows) summary[row.change] += 1;
  return { jobs: loaded.map(({ job }) => serializeJob(job)), by: mode, rows, summary };
}
