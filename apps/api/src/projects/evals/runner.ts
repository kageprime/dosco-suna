/**
 * The eval runner: one tick advances every open trial of every open job by
 * one step. It runs only on the leader (`worker/jobs/eval-runner.ts`), so one
 * process writes a trial at a time.
 *
 * A trial is Harbor's trial lifecycle on a Kortix session:
 *
 *   queued        waits for a slot (`n_concurrent_trials`)
 *   starting      the session is created; its sandbox boots
 *   agent_running the agent works on the instruction (or `oracle` runs solve.sh)
 *   verifying     tests/ is uploaded, tests/test.sh runs, it writes the reward
 *   completed | errored | cancelled
 *
 * The tests reach the sandbox only after the agent has stopped. An error is
 * recorded once, with its policy: `should_grade` still runs the verifier,
 * `has_valid_reward` lets the reward count, `should_retry` queues another run.
 *
 * Every step is short and repeatable: a step that dies leaves the trial in
 * its status, and the next tick runs the step again.
 */
import { randomUUID } from 'node:crypto';
import { evalTrials, gatewayRequestLogs, projectSessions, sandboxTemplates, sessionTurns } from '@kortix/db';
import { EVAL_LIMITS, isEvalBuiltinAgent, type EvalException, type EvalJobConfig, type EvalRewards } from '@kortix/api-contract';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { createTemplate, listTemplatesForProject } from '../../snapshots/templates';
import { projectsView } from '../../workspaces/rows';
import { withProjectGitAuth } from '../lib/git';
import type { ProjectRow } from '../lib/serializers';
import { extendSandboxDeadline } from '../sandbox-deadline';
import { createSession, drainSessionLifecycleQueue, enqueueContinueSessionCommand } from '../session-lifecycle';
import { abortRuntimeTurn } from '../session-lifecycle/abort-runtime-turn';
import { stopSession } from '../session-lifecycle/stop';
import { boxOps, boxReady, kill, launch, listFiles, poll, readTextFile, sessionBox, uploadDir, type Box } from './box';
import { dockerfileCopies, dockerfileSteps, dockerfileWorkdir, INLINE_CONTEXT_LIMITS, inlineDockerfile, renderDockerfile, type DockerfileStep, healthcheckStep, withoutHarborIgnored, type HarborHealthcheck, type HarborTask, type HealthcheckState } from './harbor-task';
import { artifactFiles, type CollectedArtifact } from './artifacts';
import { readArtifacts, restoreArtifacts } from './artifact-transfer';
import { EvalTrialError, parseRewards, shouldRetry, toEvalException, turnFailureType } from './scoring';
import { serializeJob, serializeTrial } from './serialize';
import { evalsDrive, json, trialFolder, writeEvalFiles, type StoredFile } from './storage';
import {
  ACTIVE_TRIAL_STATUSES,
  countActiveTrials,
  endedTrialsWithLiveSandbox,
  getJob,
  getTrial,
  insertRetry,
  jobConfig,
  listOpenJobs,
  listOpenTrials,
  listTrials,
  OPEN_JOB_STATUSES,
  refreshJobStats,
  setJobStatus,
  startedByOf,
  updateTrial,
  type EvalJobRow,
  type EvalTrialRow,
} from './store';
import { loadTask, loadTaskFolder, treeFor, type EvalTaskRef } from './task-source';
import { readManifestEvals } from './config';
import { readSessionLogPage } from '../session-log-read';
import { FEATURE_FLAGS_ENV_NAME, featureFlagsEnvValue } from '../lib/feature-flag-env';

/** The source of every session the runner creates. */
export const EVAL_SESSION_SOURCE = 'system:eval' as const;

/** Trials of one project that may hold a sandbox at once, across its jobs. */
const PROJECT_ACTIVE_TRIALS_MAX = EVAL_LIMITS.n_concurrent_trials_max;
/** On top of the task's `build_timeout_sec`: the sandbox boot itself. */
const ENVIRONMENT_START_MARGIN_MS = 10 * 60_000;
/** A session whose first turn has no ledger row this long after the sandbox answered never got its prompt. */
const TURN_START_MAX_MS = 10 * 60_000;
/** After the runner aborts a turn, how long it waits for the turn to end before it grades anyway. */
const ABORT_SETTLE_MS = 60_000;
/**
 * An agent that hands work off (My Kortix's prompt: "every piece of real work
 * goes to the agent made for it") answers once its colleagues report. Its
 * trial is graded after its turn ended and every session it started has been
 * idle this long: the report's notice reaches it, and its answer turn opens,
 * well inside this window.
 */
const QUIET_MS = 30_000;
/** A colleague with no turn yet is still starting, for at most this long. */
const COLLEAGUE_START_MAX_MS = 10 * 60_000;
/** Kept alive this long past each tick while the runner, not a turn, uses the sandbox. */
const RUNNER_DEADLINE_GRANT_MS = 10 * 60_000;
const VERIFIER_FILES_MAX = 20;

interface RunState {
  /** The session exists (`createSession` returned). */
  session_created?: boolean;
  /** The sandbox template the session boots, when the task needs its own. */
  sandbox_slug?: string | null;
  agent_timeout_sec?: number;
  verifier_timeout_sec?: number;
  workdir?: string | null;
  /** When the runner aborted the agent's turn for running past its timeout. */
  aborted_at?: string;
  /** When the runner last read the session's token use. */
  usage_at?: string;
  /** Since when the agent's turn has ended and no colleague it started is working. */
  quiet_since?: string;
  /** `[environment.healthcheck]`, copied at start: it runs before the agent gets its instruction. */
  healthcheck?: HarborHealthcheck | null;
  healthcheck_state?: HealthcheckState;
  healthcheck_passed?: boolean;
  /** The session was created without its instruction (a healthcheck runs first): it is sent once the check passes. */
  prompt_deferred?: boolean;
  prompt_sent?: boolean;
  /** The agent phase's artifacts are in the trial folder. */
  artifacts_collected?: boolean;
  /** A separate verifier: its own session and sandbox. */
  verifier_session_id?: string;
  verifier_session_created?: boolean;
  verifier_slug?: string | null;
  /** When the separate verifier's sandbox was asked for, and when its tests started. */
  verifier_env_started_at?: string;
  verifier_launched_at?: string;
}

const runState = (trial: EvalTrialRow): RunState => (trial.runState ?? {}) as RunState;
const taskRef = (trial: EvalTrialRow): EvalTaskRef => trial.taskRef as unknown as EvalTaskRef;
const elapsed = (since: Date | null, now: Date): number => (since ? now.getTime() - since.getTime() : 0);

interface TrialContext {
  job: EvalJobRow;
  config: EvalJobConfig;
  project: ProjectRow;
  now: Date;
}

async function loadProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row ?? null;
}

async function loadTrialTask(ctx: TrialContext, trial: EvalTrialRow): Promise<{ task: HarborTask; tree: ReturnType<typeof treeFor> }> {
  const gitProject = await withProjectGitAuth(ctx.project);
  const tree = treeFor(gitProject, ctx.job.commitSha ?? gitProject.defaultBranch, taskRef(trial));
  return { task: await loadTask(tree, taskRef(trial)), tree };
}

// ── Timeouts ─────────────────────────────────────────────────────────────────

export function agentTimeoutSec(config: EvalJobConfig, agentName: string, model: string | null, task: Pick<HarborTask, 'agentTimeoutSec'>): number {
  const agent = config.agents.find((entry) => entry.name === agentName && (entry.model_name ?? null) === model) ?? config.agents.find((entry) => entry.name === agentName);
  let seconds = agent?.override_timeout_sec ?? task.agentTimeoutSec;
  if (agent?.max_timeout_sec) seconds = Math.min(seconds, agent.max_timeout_sec);
  return seconds * (config.agent_timeout_multiplier ?? config.timeout_multiplier);
}

export function verifierTimeoutSec(config: EvalJobConfig, task: Pick<HarborTask, 'verifierTimeoutSec'>): number {
  return task.verifierTimeoutSec * (config.verifier_timeout_multiplier ?? config.timeout_multiplier);
}

// ── The sandbox a task needs ─────────────────────────────────────────────────

const gb = (mb: number | null): number | undefined => (mb ? Math.max(1, Math.ceil(mb / 1024)) : undefined);

/**
 * The `sandbox.templates` slug a trial boots, or null for the agent's own
 * sandbox. A task that names `docker_image` or ships a Dockerfile gets a
 * template of its own, made on first use and shared by every later trial of
 * the same image and size. A Dockerfile in the project repository that copies
 * nothing builds from its path. Any other Dockerfile builds from its text; one
 * that copies the task's files has them written in when the template is made
 * (`inlineDockerfile`): templates build without a build context.
 */
export interface TemplateNeed {
  slug: string;
  image: string | null;
  dockerfilePath: string | null;
  /** The Dockerfile itself, when it copies nothing from the task. */
  dockerfile: string | null;
  /** A Dockerfile that copies the task's files: its steps and the task folder its context is (`environment`, `tests`). */
  context: { folder: string; steps: DockerfileStep[] } | null;
  spec: { cpu?: number; memoryGb?: number; diskGb?: number };
}

/** What a task's files are at: the identity of a template built from them. */
function contentIdentity(ref: EvalTaskRef, commit: string | null): string {
  if (ref.kind === 'package') return `pkg:${ref.org}/${ref.name}@${ref.content_hash}`;
  if (ref.kind === 'git') return `git:${ref.git_url}@${ref.commit}/${ref.path}`;
  return `repo:${commit ?? ''}/${ref.path}`;
}

/** One environment definition as a template: a prebuilt image, a Dockerfile in the project repository, or a Dockerfile's text. */
function templateNeed(
  definition: { dockerImage: string | null; hasDockerfile: boolean; dockerfile: string | null; cpus: number | null; memoryMb: number | null; storageMb: number | null },
  file: string,
  ref: EvalTaskRef,
  commit: string | null,
): TemplateNeed | null {
  if (!definition.dockerImage && !definition.hasDockerfile) return null;
  let steps: DockerfileStep[] | null = null;
  if (!definition.dockerImage) {
    if (!definition.dockerfile?.trim()) throw new EvalTrialError('TaskUnsupportedError', `This task's ${file} is empty or could not be read.`);
    const read = dockerfileSteps(definition.dockerfile, file);
    if ('reason' in read) throw new EvalTrialError('TaskUnsupportedError', read.reason);
    steps = read;
  }
  const copies = steps !== null && dockerfileCopies(steps);
  const dockerfilePath = steps && !copies && ref.kind === 'repo' ? `${ref.path}/${file}` : null;
  const dockerfile = steps && !copies && !dockerfilePath ? renderDockerfile(steps) : null;
  const context = steps && copies ? { folder: file.slice(0, file.lastIndexOf('/')), steps } : null;
  const spec = { cpu: definition.cpus ? Math.ceil(definition.cpus) : undefined, memoryGb: gb(definition.memoryMb), diskGb: gb(definition.storageMb) };
  // A template that copies the task's files is the Dockerfile and those files: the task's content names it.
  const source = definition.dockerImage ?? dockerfilePath ?? (context ? `context:${definition.dockerfile}:${contentIdentity(ref, commit)}` : `dockerfile:${dockerfile}`);
  const identity = JSON.stringify([source, spec.cpu ?? 0, spec.memoryGb ?? 0, spec.diskGb ?? 0]);
  return { slug: `eval-${new Bun.CryptoHasher('sha256').update(identity).digest('hex').slice(0, 16)}`, image: definition.dockerImage ?? null, dockerfilePath, dockerfile, context, spec };
}

/** The project sandbox template a task's custom environment needs, or null for the default sandbox. Pure: the job start checks it too. */
export function templateNeedFor(task: HarborTask, ref: EvalTaskRef, commit: string | null = null): TemplateNeed | null {
  return templateNeed(task, 'environment/Dockerfile', ref, commit);
}

/**
 * The template a separate verifier boots, by Harbor's image precedence, or
 * null for a fresh default sandbox. `tests/Dockerfile` builds without the
 * tests folder as its context, so the runner uploads the tests into that
 * image too (to `/tests`, where the Dockerfile copies them).
 */
export function verifierTemplateNeedFor(task: HarborTask, ref: EvalTaskRef, commit: string | null = null): TemplateNeed | null {
  const env = task.verifierEnvironment;
  if (task.verifierMode !== 'separate' || !env) return null;
  return templateNeed(env, env.source === 'tests-dockerfile' ? 'tests/Dockerfile' : 'environment/Dockerfile', ref, commit);
}

/** Every template a task's trial may create: the agent's and a separate verifier's. */
export function templateNeedsFor(task: HarborTask, ref: EvalTaskRef, commit: string | null = null): TemplateNeed[] {
  return [templateNeedFor(task, ref, commit), verifierTemplateNeedFor(task, ref, commit)].filter((need): need is TemplateNeed => need !== null);
}

async function sandboxSlugFor(ctx: TrialContext, task: HarborTask, ref: EvalTaskRef): Promise<string | null> {
  if (ctx.config.environment.sandbox) return ctx.config.environment.sandbox;
  const need = templateNeedFor(task, ref, ctx.job.commitSha);
  return need ? ensureTemplate(ctx, need, task.dockerImage ?? task.name, ref) : null;
}

/** The Dockerfile a template is made from: the task's files written in when it copies them. */
async function templateDockerfile(ctx: TrialContext, need: TemplateNeed, ref: EvalTaskRef): Promise<string | null> {
  if (!need.context) return need.dockerfile;
  const gitProject = await withProjectGitAuth(ctx.project);
  const tree = treeFor(gitProject, ctx.job.commitSha ?? gitProject.defaultBranch, ref);
  const root = `${ref.path ? `${ref.path}/` : ''}${need.context.folder}`;
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const path of await tree.list(root)) {
    if (!path.startsWith(`${root}/`)) continue;
    const bytes = await tree.read(path);
    total += bytes.byteLength;
    // Past the limit inlineDockerfile names the reason; the read stops here.
    if (total > INLINE_CONTEXT_LIMITS.bytes * 4) break;
    files.set(path.slice(root.length + 1), bytes);
  }
  const built = inlineDockerfile(need.context.steps, files);
  if ('reason' in built) throw new EvalTrialError('TaskUnsupportedError', built.reason);
  return built.dockerfile;
}

/** Make a template on first use, when whoever started the job may. */
async function ensureTemplate(ctx: TrialContext, need: TemplateNeed, label: string, ref: EvalTaskRef): Promise<string> {
  const { slug, image, dockerfilePath, spec } = need;
  const gitProject = await withProjectGitAuth(ctx.project);
  const existing = (await listTemplatesForProject(gitProject)).find((template) => template.slug === slug);
  if (existing) return slug;
  // A sandbox template is project infrastructure (POST /sandbox-templates needs project.sandbox.write): a job creates
  // one only when whoever started it holds that capability.
  if (startedByOf(ctx.job)?.may_create_templates !== true) {
    throw new EvalTrialError(
      'SandboxBuildFailedError',
      `This task needs a sandbox template for ${image ?? dockerfilePath ?? 'its Dockerfile'}, which this project does not have, and whoever started the job may not create one (project.sandbox.write).`,
    );
  }
  const dockerfile = image || dockerfilePath ? null : await templateDockerfile(ctx, need, ref);
  try {
    await createTemplate({
      projectId: ctx.project.projectId,
      accountId: ctx.project.accountId,
      slug,
      name: `Eval: ${label.slice(0, 80)}`,
      ...(image ? { image } : dockerfilePath ? { dockerfilePath } : { dockerfile: dockerfile! }),
      ...spec,
      source: 'ui',
    });
  } catch (err) {
    // Another trial of the same image made it between the read and the insert.
    if (!(await listTemplatesForProject(gitProject, { forceTomlSync: false })).some((template) => template.slug === slug)) {
      throw new EvalTrialError('SandboxBuildFailedError', `The sandbox template for this task could not be made: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return slug;
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** The prompt of a trial: the task's instruction, plus where the task's files are when that is not the agent's own folder. */
export function trialPrompt(task: Pick<HarborTask, 'instruction' | 'workdir'>): string {
  if (!task.workdir || task.workdir === '/workspace') return task.instruction;
  return `${task.instruction}\n\nThe working directory of this task is ${task.workdir}.`;
}

async function sessionExists(sessionId: string): Promise<{ status: string; model: string | null } | null> {
  const [row] = await db
    .select({ status: projectSessions.status, model: sql<string | null>`${projectSessions.metadata}->>'model'` })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** Why a trial's sandbox did not start: its template's build error when it has one. */
async function sandboxFailure(ctx: TrialContext, slug: string | null): Promise<string> {
  if (slug) {
    const [template] = await db
      .select({ state: sandboxTemplates.providerState, error: sandboxTemplates.lastError })
      .from(sandboxTemplates)
      .where(and(eq(sandboxTemplates.projectId, ctx.project.projectId), eq(sandboxTemplates.slug, slug)))
      .limit(1)
      .catch(() => []);
    if (template?.state === 'error' && template.error) return `The sandbox template ${slug} did not build: ${template.error.slice(0, 600)}`;
  }
  return 'The session failed to start its sandbox.';
}

/** `kortix/deepseek-v4.1-flash` → `deepseek-v4.1-flash`: the id the job config and the leaderboard name. */
const modelId = (ref: string | null): string | null => (ref ? ref.replace(/^kortix\//, '') : null);

/**
 * The agent a session of `oracle` or `nop` runs as. They call no model, so the
 * session only provides the sandbox: the first agent kortix.yaml declares,
 * because My Kortix (often the default) always boots its own sandbox and never
 * a task's image.
 */
async function sandboxAgentFor(ctx: TrialContext): Promise<string> {
  const gitProject = await withProjectGitAuth(ctx.project);
  const { declared } = await readManifestEvals(gitProject, ctx.job.commitSha ?? gitProject.defaultBranch).catch(() => ({ declared: [] as string[] }));
  return declared.find((name) => name !== 'mykortix' && name !== 'my_kortix') ?? 'default';
}

/** queued → starting: read the task, pick the sandbox, create the session. */
async function startTrial(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  const state = runState(trial);
  if (!trial.sessionId) {
    const { task } = await loadTrialTask(ctx, trial);
    if (task.unsupported) throw new EvalTrialError('TaskUnsupportedError', task.unsupported);
    if (trial.agent === 'oracle' && !task.hasSolution) throw new EvalTrialError('SolutionNotFoundError', 'The oracle agent runs solution/solve.sh, and this task has none.');
    const billing = await checkBillingAdmission(ctx.project.accountId);
    if (!billing.ok) throw new EvalTrialError('BillingBlockedError', billing.message);
    const next: RunState = {
      ...state,
      session_created: false,
      sandbox_slug: await sandboxSlugFor(ctx, task, taskRef(trial)),
      agent_timeout_sec: agentTimeoutSec(ctx.config, trial.agent, trial.model, task),
      verifier_timeout_sec: verifierTimeoutSec(ctx.config, task),
      workdir: task.workdir,
      healthcheck: task.healthcheck,
      // The agent may not start before the healthcheck passes: its instruction waits.
      prompt_deferred: Boolean(task.healthcheck) && !isEvalBuiltinAgent(trial.agent),
    };
    // The id is stored before the create, so a create whose answer is lost is found again, not repeated.
    const sessionId = randomUUID();
    if (!(await updateTrial(trial, { sessionId, runState: next as Record<string, unknown>, startedAt: trial.startedAt ?? ctx.now, environmentStartedAt: ctx.now }))) return;
    trial = { ...trial, sessionId, runState: next as Record<string, unknown> };
  }
  if (runState(trial).session_created) return;
  if (!(await sessionExists(trial.sessionId!))) {
    const { task } = await loadTrialTask(ctx, trial);
    const builtin = isEvalBuiltinAgent(trial.agent);
    // The session runs as whoever started the job, with that principal's grants. It is always a top-level session, never the
    // caller's child: a child runs another harness (no follow-through check, no goal mode), so a job an agent starts would
    // score a harness nobody uses.
    const startedBy = startedByOf(ctx.job);
    const result = await createSession({
      source: EVAL_SESSION_SOURCE,
      project: ctx.project,
      userId: ctx.job.createdBy ?? ctx.project.accountId,
      requestingPrincipalType: startedBy?.principal_type ?? 'human',
      authType: startedBy?.auth_type ?? null,
      apiKeyType: startedBy?.api_key_type ?? null,
      inSession: startedBy?.in_session ?? false,
      callerSessionId: null,
      body: {
        session_id: trial.sessionId,
        name: `Eval: ${trial.taskName} · ${trial.agent}`.slice(0, 120),
        // `oracle` and `nop` run no model: the session only provides the sandbox.
        agent_name: builtin ? await sandboxAgentFor(ctx) : trial.agent,
        ...(!builtin && trial.model ? { model: trial.model } : {}),
        ...(!builtin && !runState(trial).prompt_deferred ? { initial_prompt: trialPrompt(task) } : {}),
        ...(runState(trial).sandbox_slug ? { sandbox_slug: runState(trial).sandbox_slug } : {}),
      },
      metadata: { eval_job_id: ctx.job.jobId, eval_trial_id: trial.trialId, eval_task: trial.taskName, eval_agent: trial.agent },
      ...(Object.keys(task.environmentEnv).length ? { extraEnvVars: task.environmentEnv } : {}),
    });
    if (result.error) {
      const message = String(result.error.body?.error ?? result.error.body?.message ?? 'The session could not start.');
      logger.warn('[evals] trial session not created', { trial_id: trial.trialId, agent: trial.agent, status: result.error.status, error: message });
      throw new EvalTrialError(result.error.status === 402 ? 'BillingBlockedError' : 'SessionCreateError', message);
    }
  }
  // A cancel that landed while the session was created: its sandbox stops now, not on the sweep.
  if (!(await updateTrial(trial, { runState: { ...runState(trial), session_created: true } as Record<string, unknown> }))) {
    const now = await getTrial(ctx.job.jobId, trial.trialId);
    if (now?.status === 'cancelled') await stopTrialSandbox(ctx.job, trial.sessionId!);
  }
}

/** starting → agent_running (or → verifying for `nop`), once the sandbox answers. */
async function awaitEnvironment(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  const state = runState(trial);
  if (!state.session_created) return startTrial(ctx, trial);
  const session = await sessionExists(trial.sessionId!);
  if (!session) throw new EvalTrialError('SessionCreateError', 'The trial session no longer exists.');
  if (session.status === 'failed') throw new EvalTrialError('SandboxBuildFailedError', await sandboxFailure(ctx, state.sandbox_slug ?? null));
  const found = await sessionBox(trial.sessionId!);
  const builtin = isEvalBuiltinAgent(trial.agent);
  if (!found?.box || !(await boxReady(found.box))) {
    const { task } = await loadTrialTask(ctx, trial).catch(() => ({ task: null }));
    const limitMs = (task?.buildTimeoutSec ?? 600) * 1000 * ctx.config.timeout_multiplier + ENVIRONMENT_START_MARGIN_MS;
    if (elapsed(trial.environmentStartedAt, ctx.now) > limitMs) {
      throw new EvalTrialError('EnvironmentStartTimeoutError', `The sandbox did not start within ${Math.round(limitMs / 60_000)} min.`);
    }
    return;
  }
  const box = found.box;
  await extendSandboxDeadline({ sessionId: trial.sessionId! }, RUNNER_DEADLINE_GRANT_MS);
  // Harbor's log folders, the artifacts publish folder among them, exist before the agent runs.
  await boxExec(box, 'mkdir -p /logs/agent /logs/verifier /logs/artifacts');
  let current = state;
  if (state.healthcheck && !state.healthcheck_passed) {
    const checked = await runHealthcheck(ctx, trial, box, state.healthcheck);
    if (!checked) return;
    current = checked;
  }
  if (!builtin) {
    if (current.prompt_deferred && !current.prompt_sent) await sendDeferredPrompt(ctx, trial, current);
    // The model the session resolved, when the config names none: a score is only comparable with its model.
    await updateTrial(trial, { status: 'agent_running', environmentFinishedAt: ctx.now, agentStartedAt: ctx.now, ...(trial.model ? {} : { model: modelId(session.model) }) });
    return;
  }
  if (trial.agent === 'nop') {
    if (!(await updateTrial(trial, { status: 'agent_running', environmentFinishedAt: ctx.now, agentStartedAt: ctx.now, agentFinishedAt: ctx.now }))) return;
    return beginVerify(ctx, { ...trial, status: 'agent_running' }, box);
  }
  const { task, tree } = await loadTrialTask(ctx, trial);
  await uploadDir(box, '/solution', withoutHarborIgnored(await loadTaskFolder(tree, taskRef(trial), 'solution')));
  await launch(box, `solve-${trial.trialId}`, {
    command: 'bash /solution/solve.sh',
    cwd: task.workdir,
    env: { ...task.environmentEnv, ...task.solutionEnv },
    timeoutSec: state.agent_timeout_sec ?? task.agentTimeoutSec,
    outputPath: '/logs/agent/oracle.txt',
  });
  await updateTrial(trial, { status: 'agent_running', environmentFinishedAt: ctx.now, agentStartedAt: ctx.now });
}

async function boxExec(box: Box, script: string): Promise<void> {
  const result = await boxOps().exec(box, script, 30_000);
  if (result.exitCode !== 0) throw new EvalTrialError('RuntimeRequestError', result.stderr.slice(0, 300) || `exit ${result.exitCode}`);
}

/**
 * Run the task's healthcheck once, when its next check is due. The run state
 * once it passed, else null; throws `HealthcheckError` when it failed
 * `retries` times in a row after the start period. One check per tick: the
 * tick is the interval's floor.
 */
async function runHealthcheck(ctx: TrialContext, trial: EvalTrialRow, box: Box, hc: HarborHealthcheck): Promise<RunState | null> {
  const state = runState(trial);
  if (state.healthcheck_state && ctx.now.getTime() < Date.parse(state.healthcheck_state.next_at)) return null;
  const seconds = Math.max(1, Math.ceil(hc.timeoutSec));
  const cwd = state.workdir ? `cd ${shellQuote(state.workdir)} 2>/dev/null || true; ` : '';
  const result = await boxOps()
    .exec(box, `${cwd}timeout -k 5 ${seconds} bash -c ${shellQuote(hc.command)} > /dev/null 2>&1`, (seconds + 15) * 1000)
    .catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
  const step = healthcheckStep(hc, state.healthcheck_state ?? null, ctx.now, result.exitCode === 0);
  if (step.outcome === 'failed') throw new EvalTrialError('HealthcheckError', `Healthcheck failed after ${hc.retries} consecutive retries: ${hc.command}`);
  const next: RunState = { ...state, healthcheck_state: step.state, healthcheck_passed: step.outcome === 'passed' };
  if (!(await updateTrial(trial, { runState: next as Record<string, unknown> }))) return null;
  return next.healthcheck_passed ? next : null;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Send the instruction a session was created without. It goes through the
 * durable prompt queue with a key of its own, so a tick that dies after the
 * send sends nothing twice.
 */
async function sendDeferredPrompt(ctx: TrialContext, trial: EvalTrialRow, state: RunState): Promise<void> {
  const { task } = await loadTrialTask(ctx, trial);
  const idempotencyKey = `eval-prompt:${trial.trialId}`;
  await enqueueContinueSessionCommand({
    source: EVAL_SESSION_SOURCE,
    projectId: ctx.project.projectId,
    accountId: ctx.project.accountId,
    sessionId: trial.sessionId!,
    actorUserId: ctx.job.createdBy ?? ctx.project.accountId,
    text: trialPrompt(task),
    idempotencyKey,
  });
  drainSessionLifecycleQueue({ idempotencyKey, burst: false }).catch(() => {});
  await updateTrial(trial, { runState: { ...state, prompt_sent: true } as Record<string, unknown> });
}

/** The session's first turn, once the ledger has it. */
async function firstTurn(sessionId: string): Promise<{ state: string; endReason: string | null; endError: { name?: string | null; message?: string | null } | null } | null> {
  const rows = await db
    .select({ state: sessionTurns.state, endReason: sessionTurns.endReason, endError: sessionTurns.endError, startedAt: sessionTurns.startedAt })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId))
    .orderBy(desc(sessionTurns.startedAt))
    .limit(20);
  if (rows.length === 0) return null;
  // The agent is done when no turn is open: a delivered prompt can leave an `abandoned` row beside the real turn.
  const open = rows.find((row) => row.state !== 'ended');
  if (open) return open;
  return rows.find((row) => row.endReason === 'completed') ?? rows.find((row) => row.endReason === 'failed') ?? rows[0]!;
}

/** agent_running: wait for the agent to stop, then grade. */
async function awaitAgent(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  const state = runState(trial);
  const found = await sessionBox(trial.sessionId!);
  const timeoutMs = (state.agent_timeout_sec ?? EVAL_LIMITS.agent_timeout_sec_default) * 1000;
  const ranMs = elapsed(trial.agentStartedAt, ctx.now);

  if (trial.agent === 'oracle') {
    if (!found?.box) throw new EvalTrialError('SandboxGoneError', 'The sandbox stopped while the solution ran.');
    await extendSandboxDeadline({ sessionId: trial.sessionId! }, RUNNER_DEADLINE_GRANT_MS);
    const run = await poll(found.box, `solve-${trial.trialId}`);
    if (run.state === 'missing') throw new EvalTrialError('SandboxGoneError', 'The solution run was lost: the sandbox restarted.');
    if (run.state === 'running') {
      if (ranMs > timeoutMs + 30_000) {
        await kill(found.box, `solve-${trial.trialId}`);
        return agentEnded(ctx, trial, found.box, new EvalTrialError('AgentTimeoutError', `solution/solve.sh ran past ${Math.round(timeoutMs / 1000)} s.`));
      }
      return;
    }
    const failure =
      run.exitCode === 124
        ? new EvalTrialError('AgentTimeoutError', `solution/solve.sh ran past ${Math.round(timeoutMs / 1000)} s.`)
        : run.exitCode !== 0
          ? new EvalTrialError('NonZeroAgentExitCodeError', `solution/solve.sh exited ${run.exitCode}.`)
          : null;
    return agentEnded(ctx, trial, found.box, failure);
  }

  const turn = await firstTurn(trial.sessionId!);
  if (state.aborted_at) {
    const settled = turn?.state === 'ended' || ctx.now.getTime() - Date.parse(state.aborted_at) > ABORT_SETTLE_MS;
    if (!settled) return;
    return agentEnded(ctx, trial, found?.box ?? null, new EvalTrialError('AgentTimeoutError', `The agent ran past ${Math.round(timeoutMs / 1000)} s.`));
  }
  if (!turn) {
    if (ranMs > TURN_START_MAX_MS) throw new EvalTrialError('AgentTurnFailedError', 'The instruction never reached the agent.');
    return;
  }
  if (turn.state !== 'ended') {
    if (state.quiet_since) await updateTrial(trial, { runState: { ...state, quiet_since: undefined } as Record<string, unknown> });
    if (ranMs <= timeoutMs) return;
    await abortRuntimeTurn(trial.sessionId!, { requestedStop: true, stoppedBy: null }).catch(() => false);
    await updateTrial(trial, { runState: { ...state, aborted_at: ctx.now.toISOString() } as Record<string, unknown> });
    return;
  }
  if (turn.endReason === 'completed') {
    const quiet = await colleaguesQuiet(ctx, trial, state);
    if (quiet === 'quiet') return agentEnded(ctx, trial, found?.box ?? null, null);
    if (ranMs > timeoutMs) return agentEnded(ctx, trial, found?.box ?? null, new EvalTrialError('AgentTimeoutError', `The agent's colleagues ran past ${Math.round(timeoutMs / 1000)} s.`));
    return;
  }
  if (turn.endReason === 'runtime_gone') throw new EvalTrialError('SandboxGoneError', 'The sandbox stopped before the agent finished.');
  if (turn.endReason === 'failed') {
    const reason = turn.endError?.message?.trim() || turn.endError?.name || 'The turn failed and reported no reason.';
    return agentEnded(ctx, trial, found?.box ?? null, new EvalTrialError(turnFailureType(turn.endError), reason));
  }
  throw new EvalTrialError('AgentTurnFailedError', 'The instruction never reached the agent.');
}

/** Every session the trial session started, at any depth: hand-offs, workflow agents, teammates. */
async function descendantSessions(sessionId: string): Promise<Array<{ sessionId: string; createdAt: Date }>> {
  const result = await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT session_id, created_at FROM kortix.project_sessions WHERE parent_session_id = ${sessionId}
      UNION
      SELECT s.session_id, s.created_at FROM kortix.project_sessions s JOIN tree t ON s.parent_session_id = t.session_id
    )
    SELECT session_id, created_at FROM tree LIMIT 500`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{ session_id: string; created_at: Date | string }>;
  return rows.map((row) => ({ sessionId: row.session_id, createdAt: new Date(row.created_at) }));
}

/**
 * `quiet` when the agent started no colleague, or when every colleague has been
 * idle for {@link QUIET_MS}: no open turn, and none still starting. The clock
 * starts on the first quiet tick and restarts when any session works again.
 */
async function colleaguesQuiet(ctx: TrialContext, trial: EvalTrialRow, state: RunState): Promise<'quiet' | 'busy'> {
  const colleagues = await descendantSessions(trial.sessionId!);
  if (colleagues.length === 0) return 'quiet';
  const ids = colleagues.map((c) => c.sessionId);
  const turns = await db
    .select({ sessionId: sessionTurns.sessionId, open: sql<boolean>`bool_or(${sessionTurns.state} <> 'ended')` })
    .from(sessionTurns)
    .where(inArray(sessionTurns.sessionId, ids))
    .groupBy(sessionTurns.sessionId);
  const ran = new Map(turns.map((row) => [row.sessionId, row.open]));
  const busy = colleagues.some((c) =>
    ran.has(c.sessionId) ? ran.get(c.sessionId) === true : ctx.now.getTime() - c.createdAt.getTime() < COLLEAGUE_START_MAX_MS,
  );
  if (busy) {
    if (state.quiet_since) await updateTrial(trial, { runState: { ...state, quiet_since: undefined } as Record<string, unknown> });
    return 'busy';
  }
  if (!state.quiet_since) {
    await updateTrial(trial, { runState: { ...state, quiet_since: ctx.now.toISOString() } as Record<string, unknown> });
    return 'busy';
  }
  return ctx.now.getTime() - Date.parse(state.quiet_since) >= QUIET_MS ? 'quiet' : 'busy';
}

/**
 * The agent's last reply, as text: every text block the agent wrote after the
 * last message it received, in order. One turn often ends with two messages
 * (the answer, then "⏳ I'll check in at 9:00"), and the grader judges both,
 * as the person reads both. Null when the log holds no reply yet.
 */
export async function finalReply(sessionId: string): Promise<string | null> {
  const page = await readSessionLogPage({ sessionId, threadId: null, beforeSeq: null, limit: 100 }).catch(() => null);
  if (!page || page === 'unknown_thread') return null;
  const messages = (page as { messages?: Array<{ role?: string; blocks?: Array<{ type?: string; text?: unknown }> }> }).messages ?? [];
  const texts: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') {
      // Tool results ride on their own messages: only something the agent was told ends its last reply.
      if (message.role === 'user' && texts.length) break;
      continue;
    }
    const text = (message.blocks ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n\n').trim();
    if (text) texts.unshift(text);
  }
  return texts.length ? texts.join('\n\n') : null;
}

/**
 * Give the verifier the agent's last reply at `/logs/agent/response.md`
 * (Harbor's agent log folder): a grader of a chat agent checks or judges
 * what the agent answered, not only the files it left.
 */
async function writeFinalReply(box: Box, sessionId: string): Promise<void> {
  const reply = await finalReply(sessionId);
  if (reply === null) return;
  await uploadDir(box, '/logs/agent/reply', [{ path: 'response.md', bytes: new TextEncoder().encode(reply) as Uint8Array<ArrayBuffer> }]);
  await boxExec(box, 'mv -f /logs/agent/reply/response.md /logs/agent/response.md && rmdir /logs/agent/reply');
}

/** The agent stopped. Record its failure, then grade when the policy says so. */
async function agentEnded(ctx: TrialContext, trial: EvalTrialRow, box: Box | null, failure: EvalTrialError | null): Promise<void> {
  const exception = failure ? toEvalException(failure, ctx.config.override_error_policy, ctx.now) : null;
  if (!(await updateTrial(trial, { agentFinishedAt: ctx.now, ...(exception ? { exception: exception as unknown as Record<string, unknown> } : {}) }))) return;
  const next = { ...trial, agentFinishedAt: ctx.now, exception: (exception as unknown as Record<string, unknown> | null) ?? trial.exception };
  if (ctx.config.verifier.disable || (exception && !exception.policy.should_grade)) return finishTrial(ctx, next, null, box);
  if (!box) return finishTrial(ctx, next, null, null, toEvalException(new EvalTrialError('SandboxGoneError', 'The sandbox stopped before the verifier could run.'), ctx.config.override_error_policy, ctx.now));
  return beginVerify(ctx, next, box);
}

/** The verifier's environment: the task's (a separate verifier's own), the job's, and what a Kortix grader reads. */
function verifierEnv(ctx: TrialContext, trial: EvalTrialRow, task: HarborTask): Record<string, string> {
  return {
    ...(task.verifierMode === 'separate' && task.verifierEnvironment ? task.verifierEnvironment.env : task.environmentEnv),
    ...task.verifierEnv,
    ...ctx.config.verifier.env,
    // Which session the agent ran in: a grader inspects its loops, child sessions and log with `kortix`.
    ...(trial.sessionId ? { KORTIX_SESSION_ID: trial.sessionId } : {}),
    // The project's flags, as a session box gets them: the CLI shows a flagged command (`evals judge`,
    // `loops`) only when it knows the flag is on, and a verifier runs without the agent's environment.
    [FEATURE_FLAGS_ENV_NAME]: featureFlagsEnvValue(ctx.project.metadata),
    KORTIX_EVAL_JOB_ID: ctx.job.jobId,
    KORTIX_EVAL_TRIAL_ID: trial.trialId,
  };
}

/** The task's `tests/` as the sandbox gets them: without what `.harborignore` excludes. */
async function testsFolder(tree: ReturnType<typeof treeFor>, trial: EvalTrialRow) {
  return withoutHarborIgnored(await loadTaskFolder(tree, taskRef(trial), 'tests'));
}

/**
 * Collect the agent phase's artifacts into the trial folder, once. Harbor
 * collects after the agent stops and before any verifier runs, and a failed
 * collection is recorded in `artifacts/manifest.json`, never as a trial error.
 */
async function collectArtifacts(ctx: TrialContext, trial: EvalTrialRow, box: Box, task: Pick<HarborTask, 'artifacts' | 'workdir'>): Promise<EvalTrialRow> {
  const state = runState(trial);
  if (state.artifacts_collected) return trial;
  try {
    const collected: CollectedArtifact[] = await readArtifacts(box, { artifacts: task.artifacts, workdir: state.workdir ?? task.workdir });
    const drive = await evalsDrive(ctx.project.accountId, ctx.project.projectId);
    await writeEvalFiles(drive, trialFolder(ctx.job.folder, trial.trialName), artifactFiles(collected));
  } catch (err) {
    logger.warn('[evals] artifacts not collected', { trial_id: trial.trialId, error: String(err) });
  }
  const next = { ...state, artifacts_collected: true } as Record<string, unknown>;
  return (await updateTrial(trial, { runState: next })) ? { ...trial, runState: next } : trial;
}

/** → verifying: the tests reach a sandbox now, after the agent stopped. */
async function beginVerify(ctx: TrialContext, trial: EvalTrialRow, box: Box): Promise<void> {
  const { task, tree } = await loadTrialTask(ctx, trial);
  await extendSandboxDeadline({ sessionId: trial.sessionId! }, RUNNER_DEADLINE_GRANT_MS);
  try {
    await boxExec(box, 'mkdir -p /logs/verifier /logs/agent && rm -f -- /logs/verifier/reward.txt /logs/verifier/reward.json');
    if (!isEvalBuiltinAgent(trial.agent) && trial.sessionId) {
      await writeFinalReply(box, trial.sessionId).catch((err) => logger.warn('[evals] final reply not written', { trial_id: trial.trialId, error: String(err) }));
    }
  } catch (err) {
    throw new EvalTrialError('AddTestsDirError', `The tests could not be added to the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }
  trial = await collectArtifacts(ctx, trial, box, task);
  if (task.verifierMode === 'separate') return beginSeparateVerify(ctx, trial, task);
  try {
    await uploadDir(box, '/tests', await testsFolder(tree, trial));
  } catch (err) {
    if (err instanceof EvalTrialError && err.type === 'TaskLoadError') throw err;
    throw new EvalTrialError('AddTestsDirError', `The tests could not be added to the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }
  await launch(box, `verify-${trial.trialId}`, {
    command: 'bash /tests/test.sh',
    cwd: task.workdir,
    env: verifierEnv(ctx, trial, task),
    timeoutSec: runState(trial).verifier_timeout_sec ?? task.verifierTimeoutSec,
    outputPath: '/logs/verifier/test-stdout.txt',
  });
  await updateTrial(trial, { status: 'verifying', verifierStartedAt: ctx.now });
}

/**
 * A separate verifier (`[verifier].environment_mode = "separate"`): a fresh
 * session whose sandbox boots the verifier's environment. The trial is
 * `verifying` while that sandbox starts; the next ticks move the artifacts in
 * and run the tests there.
 */
async function beginSeparateVerify(ctx: TrialContext, trial: EvalTrialRow, task: HarborTask): Promise<void> {
  const need = ctx.config.environment.sandbox ? null : verifierTemplateNeedFor(task, taskRef(trial), ctx.job.commitSha);
  const slug = ctx.config.environment.sandbox ?? (need ? await ensureTemplate(ctx, need, `${need.image ?? task.name} (verifier)`, taskRef(trial)) : null);
  const next: RunState = { ...runState(trial), verifier_session_id: randomUUID(), verifier_session_created: false, verifier_slug: slug, verifier_env_started_at: ctx.now.toISOString() };
  if (!(await updateTrial(trial, { status: 'verifying', verifierStartedAt: ctx.now, runState: next as Record<string, unknown> }))) return;
  await createVerifierSession(ctx, { ...trial, status: 'verifying', runState: next as Record<string, unknown> }, task);
}

async function createVerifierSession(ctx: TrialContext, trial: EvalTrialRow, task: HarborTask): Promise<void> {
  const state = runState(trial);
  const sessionId = state.verifier_session_id!;
  if (!(await sessionExists(sessionId))) {
    const startedBy = startedByOf(ctx.job);
    // A task image boots on an agent that takes any template; with none, a fresh copy of the agent's own sandbox.
    const agentName = state.verifier_slug || isEvalBuiltinAgent(trial.agent) ? await sandboxAgentFor(ctx) : trial.agent;
    const result = await createSession({
      source: EVAL_SESSION_SOURCE,
      project: ctx.project,
      userId: ctx.job.createdBy ?? ctx.project.accountId,
      requestingPrincipalType: startedBy?.principal_type ?? 'human',
      authType: startedBy?.auth_type ?? null,
      apiKeyType: startedBy?.api_key_type ?? null,
      inSession: startedBy?.in_session ?? false,
      callerSessionId: null,
      body: {
        session_id: sessionId,
        name: `Eval verifier: ${trial.taskName} · ${trial.agent}`.slice(0, 120),
        agent_name: agentName,
        ...(state.verifier_slug ? { sandbox_slug: state.verifier_slug } : {}),
      },
      metadata: { eval_job_id: ctx.job.jobId, eval_trial_id: trial.trialId, eval_task: trial.taskName, eval_agent: trial.agent, eval_role: 'verifier' },
      ...(task.verifierEnvironment && Object.keys(task.verifierEnvironment.env).length ? { extraEnvVars: task.verifierEnvironment.env } : {}),
    });
    if (result.error) {
      const message = String(result.error.body?.error ?? result.error.body?.message ?? 'The verifier session could not start.');
      throw new EvalTrialError(result.error.status === 402 ? 'BillingBlockedError' : 'SessionCreateError', message);
    }
  }
  if (!(await updateTrial(trial, { runState: { ...state, verifier_session_created: true } as Record<string, unknown> }))) {
    // A cancel landed while the session was created: its sandbox stops now.
    await stopOne(ctx.job, sessionId);
  }
}

/** The working directory of `tests/Dockerfile`'s image: its last `WORKDIR`. */
async function testsDockerfileWorkdir(tree: ReturnType<typeof treeFor>, trial: EvalTrialRow): Promise<string | null> {
  const ref = taskRef(trial);
  const bytes = await tree.read(`${ref.path ? `${ref.path}/` : ''}tests/Dockerfile`).catch(() => null);
  return bytes ? dockerfileWorkdir(new TextDecoder().decode(bytes)) : null;
}

/** verifying: wait for test.sh, then read the reward it wrote. */
async function awaitVerifier(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  if (runState(trial).verifier_session_id) return awaitSeparateVerifier(ctx, trial);
  const found = await sessionBox(trial.sessionId!);
  if (!found?.box) throw new EvalTrialError('SandboxGoneError', 'The sandbox stopped while the verifier ran.');
  await extendSandboxDeadline({ sessionId: trial.sessionId! }, RUNNER_DEADLINE_GRANT_MS);
  const result = await verifierResult(ctx, trial, found.box, trial.verifierStartedAt);
  if (result) return finishTrial(ctx, trial, result.rewards, found.box, result.failure);
}

/** The separate verifier: boot its sandbox, move the artifacts and tests in, run the tests, read the reward. */
async function awaitSeparateVerifier(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  const state = runState(trial);
  const verifierSessionId = state.verifier_session_id!;
  const agent = await sessionBox(trial.sessionId!);
  if (!state.verifier_session_created) {
    const { task } = await loadTrialTask(ctx, trial);
    return createVerifierSession(ctx, trial, task);
  }
  // The agent's sandbox stays up until its artifacts are in the verifier's and the trial folder has its logs.
  await extendSandboxDeadline({ sessionId: trial.sessionId! }, RUNNER_DEADLINE_GRANT_MS).catch(() => undefined);
  await extendSandboxDeadline({ sessionId: verifierSessionId }, RUNNER_DEADLINE_GRANT_MS).catch(() => undefined);
  const session = await sessionExists(verifierSessionId);
  if (!session) throw new EvalTrialError('SessionCreateError', 'The verifier session no longer exists.');
  if (session.status === 'failed') throw new EvalTrialError('SandboxBuildFailedError', "The verifier's session failed to start its sandbox.");
  const found = await sessionBox(verifierSessionId);

  if (!state.verifier_launched_at) {
    const { task, tree } = await loadTrialTask(ctx, trial);
    if (!found?.box || !(await boxReady(found.box))) {
      const limitMs = task.buildTimeoutSec * 1000 * ctx.config.timeout_multiplier + ENVIRONMENT_START_MARGIN_MS;
      if (ctx.now.getTime() - Date.parse(state.verifier_env_started_at ?? ctx.now.toISOString()) > limitMs) {
        throw new EvalTrialError('EnvironmentStartTimeoutError', `The verifier's sandbox did not start within ${Math.round(limitMs / 60_000)} min.`);
      }
      return;
    }
    const box = found.box;
    const env = task.verifierEnvironment!;
    if (!agent?.box) throw new EvalTrialError('SandboxGoneError', "The agent's sandbox stopped before its artifacts reached the verifier.");
    try {
      await boxExec(box, 'mkdir -p /logs/verifier /logs/agent /logs/artifacts && rm -f -- /logs/verifier/reward.txt /logs/verifier/reward.json');
      await restoreArtifacts(box, await readArtifacts(agent.box, { artifacts: task.artifacts, workdir: state.workdir ?? task.workdir }));
      // A verifier image bakes its tests. tests/Dockerfile bakes them too in Harbor, but Kortix builds it without the
      // tests folder as its context, so the tests are uploaded to /tests, where its `COPY . /tests/` puts them.
      if (env.source !== 'verifier-image') await uploadDir(box, '/tests', await testsFolder(tree, trial));
    } catch (err) {
      if (err instanceof EvalTrialError && err.type === 'TaskLoadError') throw err;
      throw new EvalTrialError('AddTestsDirError', `The artifacts and tests could not be added to the verifier's sandbox: ${err instanceof Error ? err.message : String(err)}`);
    }
    const workdir = env.workdir ?? (env.source === 'task-environment' ? (state.workdir ?? task.workdir) : env.source === 'tests-dockerfile' ? await testsDockerfileWorkdir(tree, trial) : null);
    await launch(box, `verify-${trial.trialId}`, {
      command: 'bash /tests/test.sh',
      cwd: workdir,
      env: verifierEnv(ctx, trial, task),
      timeoutSec: state.verifier_timeout_sec ?? task.verifierTimeoutSec,
      outputPath: '/logs/verifier/test-stdout.txt',
    });
    await updateTrial(trial, { runState: { ...state, verifier_launched_at: ctx.now.toISOString() } as Record<string, unknown> });
    return;
  }
  if (!found?.box) throw new EvalTrialError('SandboxGoneError', "The verifier's sandbox stopped while the tests ran.");
  const result = await verifierResult(ctx, trial, found.box, new Date(state.verifier_launched_at));
  if (result) return finishTrial(ctx, trial, result.rewards, agent?.box ?? null, result.failure);
}

/** test.sh's outcome in `box`, or null while it runs inside its timeout. */
async function verifierResult(ctx: TrialContext, trial: EvalTrialRow, box: Box, launchedAt: Date | null): Promise<{ rewards: EvalRewards | null; failure: EvalException | null } | null> {
  const timeoutMs = (runState(trial).verifier_timeout_sec ?? EVAL_LIMITS.verifier_timeout_sec_default) * 1000;
  const run = await poll(box, `verify-${trial.trialId}`);
  if (run.state === 'missing') throw new EvalTrialError('SandboxGoneError', 'The verifier run was lost: the sandbox restarted.');
  if (run.state === 'running') {
    if (elapsed(launchedAt, ctx.now) <= timeoutMs + 30_000) return null;
    await kill(box, `verify-${trial.trialId}`);
  }
  const timedOut = run.state === 'running' || run.exitCode === 124;
  let rewards: EvalRewards | null = null;
  let failure: unknown = timedOut ? new EvalTrialError('VerifierTimeoutError', `tests/test.sh ran past ${Math.round(timeoutMs / 1000)} s.`) : null;
  if (!timedOut) {
    try {
      rewards = parseRewards({
        json: await readTextFile(box, '/logs/verifier/reward.json', 64 * 1024),
        text: await readTextFile(box, '/logs/verifier/reward.txt', 4 * 1024),
      });
    } catch (err) {
      failure = err;
    }
  }
  return { rewards, failure: failure ? toEvalException(failure, ctx.config.override_error_policy, ctx.now) : null };
}

/** Token use and gateway cost of a session, from the gateway's request log (project first: the index leads with it). */
async function sessionUsage(projectId: string, sessionId: string): Promise<Record<string, number> | null> {
  const [row] = await db
    .select({
      n_input_tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.inputTokens}), 0)::float8`,
      n_output_tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.outputTokens}), 0)::float8`,
      n_cache_tokens: sql<number>`coalesce(sum(${gatewayRequestLogs.cachedTokens} + ${gatewayRequestLogs.cacheWriteTokens}), 0)::float8`,
      cost_usd: sql<number | null>`sum(${gatewayRequestLogs.finalCost})::float8`,
      requests: sql<number>`count(*)::int`,
    })
    .from(gatewayRequestLogs)
    .where(and(eq(gatewayRequestLogs.projectId, projectId), eq(gatewayRequestLogs.sessionId, sessionId)));
  if (!row || !row.requests) return null;
  // No `cost_usd` key when the gateway recorded no cost: the wire reads it as null.
  return {
    n_input_tokens: Number(row.n_input_tokens),
    n_output_tokens: Number(row.n_output_tokens),
    n_cache_tokens: Number(row.n_cache_tokens),
    ...(row.cost_usd === null ? {} : { cost_usd: Number(row.cost_usd) }),
  };
}

/** Token use is read again at most this often while the agent runs. */
const LIVE_USAGE_MS = 30_000;

/** While the agent runs, keep the trial's usage current, so a running job shows its tokens and cost. */
async function refreshLiveUsage(ctx: TrialContext, trial: EvalTrialRow): Promise<EvalTrialRow> {
  if (!trial.sessionId || isEvalBuiltinAgent(trial.agent)) return trial;
  const at = runState(trial).usage_at;
  if (at && ctx.now.getTime() - Date.parse(at) < LIVE_USAGE_MS) return trial;
  const usage = await sessionUsage(ctx.job.projectId, trial.sessionId).catch(() => null);
  const state = { ...runState(trial), usage_at: ctx.now.toISOString() } as Record<string, unknown>;
  // The row's `updated_at` moves with the write; the status guard keeps a cancel in front.
  return (await updateTrial(trial, { runState: state, ...(usage ? { usage } : {}) })) ? { ...trial, runState: state, ...(usage ? { usage } : {}) } : trial;
}

/** What the verifier and the oracle left in /logs, for the trial folder: a separate verifier's /logs/verifier is in its own sandbox. */
async function collectLogs(agentBox: Box | null, verifierBox: Box | null): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  for (const [dir, box] of [['verifier', verifierBox], ['agent', agentBox]] as const) {
    if (!box) continue;
    for (const entry of await listFiles(box, `/logs/${dir}`, VERIFIER_FILES_MAX).catch(() => [])) {
      const content = await readTextFile(box, `/logs/${dir}/${entry.path}`, EVAL_LIMITS.verifier_file_bytes_max).catch(() => null);
      if (content !== null) files.push({ path: `${dir}/${entry.path}`, content });
    }
  }
  return files;
}

/**
 * End a trial: collect what the sandbox holds, write the trial folder, store
 * the result, stop the sandbox, and queue a retry when the policy asks for one.
 * `later` is an error after the agent phase; the first error of a trial is the one kept.
 */
async function finishTrial(ctx: TrialContext, trial: EvalTrialRow, rewards: EvalRewards | null, box: Box | null, later: EvalException | null = null): Promise<void> {
  const exception = ((trial.exception as EvalException | null) ?? later) || null;
  // A reward counts when the verifier wrote one and no error says otherwise. Every error of the trial must allow it.
  const rewardValid = rewards !== null && [trial.exception as EvalException | null, later].every((e) => !e || e.policy.has_valid_reward);
  const usage = trial.sessionId && !isEvalBuiltinAgent(trial.agent) ? await sessionUsage(ctx.job.projectId, trial.sessionId).catch(() => null) : null;
  // An agent phase that ended without a verifier still leaves its artifacts.
  if (box && trial.agentStartedAt && !runState(trial).artifacts_collected) {
    const loaded = await loadTrialTask(ctx, trial).catch(() => null);
    if (loaded) trial = await collectArtifacts(ctx, trial, box, loaded.task);
  }
  const verifierSessionId = runState(trial).verifier_session_id;
  const verifierBox = verifierSessionId ? ((await sessionBox(verifierSessionId).catch(() => null))?.box ?? null) : box;
  const logs = await collectLogs(box, verifierBox).catch(() => []);
  const finished: EvalTrialRow = {
    ...trial,
    status: exception ? 'errored' : 'completed',
    rewards,
    rewardValid,
    exception: exception as unknown as Record<string, unknown> | null,
    usage,
    verifierFinishedAt: trial.verifierStartedAt ? ctx.now : null,
    finishedAt: ctx.now,
  };
  const written = await updateTrial(trial, {
    status: finished.status,
    rewards,
    rewardValid,
    exception: finished.exception,
    usage,
    verifierFinishedAt: finished.verifierFinishedAt,
    finishedAt: ctx.now,
  });
  // Files follows the row: a cancel that won the write leaves no `completed` result.json behind.
  if (!written) return;
  await writeTrialFolder(ctx, finished, logs).catch((err) => logger.warn('[evals] trial folder not written', { trial_id: trial.trialId, error: String(err) }));
  if (trial.sessionId && ctx.config.environment.delete) await stopTrialSandbox(ctx.job, trial.sessionId);
  if (exception && shouldRetry(exception, ctx.config.retry, trial.retry) && !(await retryStopped(ctx.job, trial))) await insertRetry(trial);
}

/** A cancel stopped retries: a soft cancel of the job, or of this trial while it ran. */
async function retryStopped(job: EvalJobRow, trial: EvalTrialRow): Promise<boolean> {
  const fresh = await getJob(job.projectId, job.jobId);
  const state = (await getTrial(job.jobId, trial.trialId))?.runState as { no_retry?: boolean } | undefined;
  return Boolean(fresh?.cancelMode || state?.no_retry);
}

export async function stopTrialSandbox(job: EvalJobRow, sessionId: string): Promise<void> {
  // The colleagues the trial's agent started stop with it: their sandboxes bill like the trial's own.
  const colleagues = await descendantSessions(sessionId).catch(() => []);
  await Promise.all(colleagues.map((c) => stopOne(job, c.sessionId)));
  // So does a separate verifier's session, which is not the agent's child.
  const verifier = await verifierSessionOf(sessionId).catch(() => null);
  if (verifier) await stopOne(job, verifier);
  await stopOne(job, sessionId);
}

async function verifierSessionOf(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ verifier: sql<string | null>`${evalTrials.runState}->>'verifier_session_id'` })
    .from(evalTrials)
    .where(eq(evalTrials.sessionId, sessionId))
    .limit(1);
  return row?.verifier ?? null;
}

async function stopOne(job: EvalJobRow, sessionId: string): Promise<void> {
  await abortRuntimeTurn(sessionId, { requestedStop: true, stoppedBy: null }).catch(() => false);
  await stopSession({ projectId: job.projectId, sessionId, accountId: job.accountId, userId: job.createdBy ?? job.accountId, stoppedBy: null }).catch((err) =>
    logger.warn('[evals] trial sandbox not stopped', { session_id: sessionId, error: String(err) }),
  );
}

async function writeTrialFolder(ctx: TrialContext, trial: EvalTrialRow, logs: StoredFile[]): Promise<void> {
  const drive = await evalsDrive(ctx.project.accountId, ctx.project.projectId);
  const wire = serializeTrial(ctx.job, trial);
  await writeEvalFiles(drive, trialFolder(ctx.job.folder, trial.trialName), [
    { path: 'config.json', content: json({ job_id: ctx.job.jobId, job_name: ctx.job.jobName, commit: ctx.job.commitSha, task: { name: trial.taskName, ...taskRef(trial) }, agent: { name: trial.agent, model_name: trial.model }, attempt: trial.attempt, retry: trial.retry }) },
    {
      path: 'result.json',
      content: json({
        id: wire.trial_id,
        task_name: wire.task_name,
        trial_name: wire.trial_name,
        agent_info: { name: wire.agent, model_info: wire.model ? { name: wire.model } : null },
        session_id: wire.session_id,
        verifier_result: wire.rewards ? { rewards: wire.rewards } : null,
        reward_valid: wire.reward_valid,
        exception_info: wire.exception,
        agent_result: wire.usage,
        started_at: wire.started_at,
        finished_at: wire.finished_at,
        environment_setup: wire.environment_setup,
        agent_execution: wire.agent_execution,
        verifier: wire.verifier,
      }),
    },
    ...logs,
  ]);
}

/**
 * A step threw: record the error and end the trial. An error of the agent
 * phase that still grades goes to the verifier first.
 */
async function failTrial(ctx: TrialContext, stale: EvalTrialRow, err: unknown): Promise<void> {
  // The step may have written the row before it threw: work on what is stored.
  const trial = await getTrial(ctx.job.jobId, stale.trialId);
  if (!trial || !(ACTIVE_TRIAL_STATUSES as string[]).includes(trial.status)) return;
  const exception = toEvalException(err, ctx.config.override_error_policy, ctx.now);
  if (!(err instanceof EvalTrialError)) logger.warn('[evals] trial step failed', { trial_id: trial.trialId, status: trial.status, error: String(err) });
  const box = trial.sessionId ? ((await sessionBox(trial.sessionId).catch(() => null))?.box ?? null) : null;
  const gradeFirst = trial.status === 'agent_running' && !trial.exception && exception.policy.should_grade && box && !ctx.config.verifier.disable;
  if (!gradeFirst) return finishTrial(ctx, trial, null, box, exception);
  const stored = exception as unknown as Record<string, unknown>;
  if (!(await updateTrial(trial, { exception: stored, agentFinishedAt: ctx.now }))) return;
  const failed = { ...trial, exception: stored, agentFinishedAt: ctx.now };
  try {
    await beginVerify(ctx, failed, box);
  } catch (verifyErr) {
    await finishTrial(ctx, failed, null, box, toEvalException(verifyErr, ctx.config.override_error_policy, ctx.now));
  }
}

async function advanceTrial(ctx: TrialContext, trial: EvalTrialRow): Promise<void> {
  try {
    if (trial.status === 'starting') await awaitEnvironment(ctx, trial);
    else if (trial.status === 'agent_running') await awaitAgent(ctx, await refreshLiveUsage(ctx, trial));
    else if (trial.status === 'verifying') await awaitVerifier(ctx, trial);
  } catch (err) {
    await failTrial(ctx, trial, err).catch((inner) => logger.error('[evals] trial could not be ended', { trial_id: trial.trialId, error: String(inner) }));
  }
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** Write the job's `result.json` and end it: `completed`, or `cancelled` after a soft cancel drained it. */
async function completeJob(job: EvalJobRow, project: ProjectRow, now: Date): Promise<void> {
  const stats = await refreshJobStats(job);
  const cancelMode = (await getJob(job.projectId, job.jobId))?.cancelMode ?? job.cancelMode;
  if (!(await setJobStatus(job.jobId, OPEN_JOB_STATUSES, { status: cancelMode ? 'cancelled' : 'completed', finishedAt: now }))) return;
  const done = await getJob(job.projectId, job.jobId);
  if (!done) return;
  const trials = await listTrials(job.jobId);
  await writeEvalFiles(await evalsDrive(project.accountId, project.projectId), job.folder, [
    { path: 'result.json', content: json({ ...serializeJob(done), stats, trials: trials.map((trial) => ({ trial_name: trial.trialName, task_name: trial.taskName, agent: trial.agent, model: trial.model, status: trial.status, rewards: trial.rewards, reward_valid: trial.rewardValid })) }) },
  ]).catch((err) => logger.warn('[evals] job result not written', { job_id: job.jobId, error: String(err) }));
}

async function tickJob(job: EvalJobRow, now: Date): Promise<number> {
  const project = await loadProject(job.projectId);
  if (!project) return 0;
  const config = jobConfig(job);
  const ctx: TrialContext = { job, config, project, now };
  const open = await listOpenTrials(job.jobId);
  const active = open.filter((trial) => (ACTIVE_TRIAL_STATUSES as string[]).includes(trial.status));
  await Promise.all(active.map((trial) => advanceTrial(ctx, trial)));

  // Fill free slots. A project whose flag is off starts nothing new; its running trials finish.
  const queued = open.filter((trial) => trial.status === 'queued');
  let started = 0;
  if (queued.length && resolveFeatureFlag(project.metadata, 'evals')) {
    const projectFree = PROJECT_ACTIVE_TRIALS_MAX - (await countActiveTrials(job.projectId));
    const free = Math.min(config.n_concurrent_trials - active.length, projectFree);
    const starting = queued.slice(0, Math.max(0, free));
    if (starting.length && job.status === 'queued') await setJobStatus(job.jobId, ['queued'], { status: 'running', startedAt: now });
    await Promise.all(
      starting.map(async (trial) => {
        if (!(await updateTrial(trial, { status: 'starting' }))) return;
        started += 1;
        await advanceTrial(ctx, { ...trial, status: 'starting' });
      }),
    );
  }

  const left = await listOpenTrials(job.jobId);
  if (left.length === 0) await completeJob(job, project, now);
  else if (active.length || started) await refreshJobStats(job);
  return active.length + started;
}

/** One pass over every open job. Returns the number of trials it advanced. */
export async function runEvalRunnerTick(now: Date = new Date()): Promise<number> {
  let advanced = 0;
  for (const { job, sessionId } of await endedTrialsWithLiveSandbox(20).catch(() => [])) {
    await stopTrialSandbox(job, sessionId);
  }
  for (const job of await listOpenJobs(100)) {
    try {
      advanced += await tickJob(job, now);
    } catch (err) {
      logger.error('[evals] job tick failed', { job_id: job.jobId, error: String(err) });
    }
  }
  return advanced;
}
