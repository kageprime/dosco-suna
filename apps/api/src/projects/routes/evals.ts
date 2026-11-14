/**
 * Evals: `/v1/workspaces/:workspaceId/evals/*`, legacy `/v1/projects/:workspaceId/evals/*` (project flag `evals`).
 *
 * Reads of jobs and scores need project read access. A read that returns
 * repository content (task lists, a task, its files, its results, a trial's
 * instruction) also needs `project.file.read`, the rule of every repository
 * file route. Starting, cancelling and re-running starts or stops sessions, so
 * it needs `project.session.start`. Deleting a job needs project write access.
 * The rules are in `projects/evals/service.ts`.
 *
 * POST /jobs, /rerun and a trial retry take an `Idempotency-Key` header: a
 * replay returns what the first request created (`200`), and the key with
 * another body answers `409 eval_conflict`.
 *
 * Wire contract: @kortix/api-contract evals.ts. Errors: `404 eval_not_found`
 * (also for an id that is no UUID), `409 eval_conflict`, `422 eval_invalid`
 * (with `violations`), `503 eval_unavailable` (no Files storage). Flag off:
 * `403 feature_disabled`; a capability the caller lacks: the IAM `403`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateEvalJobRequestSchema,
  EVAL_JOB_STATUSES,
  EvalCompareResponseSchema,
  EvalDatasetsResponseSchema,
  EvalErrorSchema,
  EvalJobListResponseSchema,
  EvalJobPlanResponseSchema,
  EvalJobResponseSchema,
  EvalSuitesResponseSchema,
  EvalTaskDetailResponseSchema,
  EvalTaskResultsResponseSchema,
  EvalTasksResponseSchema,
  EvalTrialDetailResponseSchema,
  EvalTrialListResponseSchema,
  EvalTrialResponseSchema,
  RerunEvalJobRequestSchema,
  type EvalJobStatus,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { driveStorageAvailable } from '../../drives/volumes';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json, lenientBody } from '../../openapi';
import { workspaceIdParam } from '../../shared/route-params';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { EvalConfigError } from '../evals/config';
import { serializeJob, serializeTrial } from '../evals/serialize';
import * as evals from '../evals/service';
import { readEvalFile, trialFolder } from '../evals/storage';
import { countJobs, getJob, listJobs, listTrials, type EvalJobFilters } from '../evals/store';
import { listEvalDatasets } from '../evals/task-source';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';

type EvalContextC = Context<AppEnv>;
const projectParams = z.object({ workspaceId: z.string() });
const jobParams = projectParams.extend({ jobId: z.string() });
const trialParams = jobParams.extend({ trialId: z.string() });
const EVAL_ERRORS = {
  403: json(EvalErrorSchema, 'feature_disabled'),
  404: json(EvalErrorSchema, 'eval_not_found'),
  409: json(EvalErrorSchema, 'eval_conflict'),
  422: json(EvalErrorSchema, 'eval_invalid, with violations'),
};

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

const notFound = (c: EvalContextC) => c.json({ error: 'eval_not_found' as const, message: 'Not found.' }, 404);

/**
 * The project and the flag. `repo`: the read returns repository content, so
 * it needs `project.file.read` (which also runs the agent-session repository
 * gate). `run`: it starts or stops sessions. `admin`: it writes the project.
 */
async function scopeOf(c: EvalContextC, need: 'read' | 'repo' | 'run' | 'admin' = 'read'): Promise<Loaded | Response> {
  const loaded = await loadProjectForUser(c, workspaceIdParam(c) ?? '', need === 'admin' ? 'write' : 'read');
  if (!loaded) return notFound(c);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'evals');
  if (gate) return gate;
  if (need === 'run' || need === 'repo') {
    const action = need === 'run' ? PROJECT_ACTIONS.PROJECT_SESSION_START : PROJECT_ACTIONS.PROJECT_FILE_READ;
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, action);
  }
  return loaded;
}

const canReadRepo = (c: EvalContextC, loaded: Loaded) =>
  projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

const invalid = (c: EvalContextC, message: string) => c.json({ error: 'eval_invalid' as const, message, violations: [message] }, 422);

/** The `Idempotency-Key` header: printable, at most 200 characters. Undefined when absent; a Response when malformed. */
function idempotencyKeyOf(c: EvalContextC): string | null | Response {
  const key = c.req.header('idempotency-key');
  if (key === undefined || key === '') return null;
  if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) return invalid(c, 'Idempotency-Key must be 1 to 200 printable characters without spaces.');
  return key;
}

/** The caller as the job row keeps it: trial sessions are created as this principal. */
async function requesterOf(c: EvalContextC, loaded: Loaded, idempotencyKey: string | null): Promise<evals.JobRequester> {
  const authType = (c.get('authType') as string | undefined) ?? null;
  const mayCreateTemplates = await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE);
  return {
    userId: loaded.userId,
    idempotencyKey,
    startedBy: {
      principal_type: authType === 'service_account' ? 'service_account' : 'human',
      auth_type: authType,
      api_key_type: (c.get('apiKeyType') as string | undefined) ?? null,
      in_session: isProjectSessionPrincipal(c),
      caller_session_id: callerKortixSessionId(c),
      may_create_templates: mayCreateTemplates,
    },
  };
}

/** A service error as its response. Anything else is a server error and propagates. */
function errorResponse(c: EvalContextC, error: unknown): Response {
  if (error instanceof EvalConfigError) return c.json({ error: 'eval_invalid' as const, message: error.message, violations: error.violations }, 422);
  if (error instanceof evals.EvalNotFoundError) return notFound(c);
  if (error instanceof evals.EvalForbiddenError) return c.json({ error: 'eval_forbidden' as const, message: error.message }, 403);
  if (error instanceof evals.EvalConflictError) return c.json({ error: 'eval_conflict' as const, message: error.message, ...(error.jobId ? { job_id: error.jobId } : {}) }, 409);
  throw error;
}

/** Files of a task or a trial reach the client as text, as written: a broken `reward.json` stays viewable. */
const FILE_BYTES_MAX = 1_000_000;
const textFile = (body: string | Uint8Array<ArrayBuffer>, cacheSeconds: number) =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `private, max-age=${cacheSeconds}`, 'X-Content-Type-Options': 'nosniff' } });

async function parseBody<T>(c: EvalContextC, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (parsed.success) return parsed.data;
  return c.json(
    { error: 'eval_invalid' as const, message: 'The request body is invalid.', violations: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) },
    422,
  );
}

/** The route's typed-response check cannot follow a shared helper's Response, so it is skipped here. */
function handler(fn: (c: EvalContextC) => Promise<Response>): never {
  return fn as never;
}

async function jobOf(c: EvalContextC, loaded: Loaded) {
  const jobId = c.req.param('jobId') ?? '';
  return isUuid(jobId) ? getJob(loaded.row.projectId, jobId) : null;
}

export function registerEvalRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals',
      tags: ['evals'],
      summary: 'List the eval suites of a project',
      description: 'The suites of `evals:` in kortix.yaml at `ref` (default: the default branch), each resolved to its job config, with its latest job. A suite that does not resolve carries `error`. Flag `evals`.',
      ...auth,
      request: { params: projectParams, query: z.object({ ref: z.string().optional() }) },
      responses: { 200: json(EvalSuitesResponseSchema, 'The suites'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      try {
        return c.json({ suites: await evals.listSuites(loaded.row, c.req.query('ref')) }, 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/tasks',
      tags: ['evals'],
      summary: 'List the tasks of a suite, a path or a dataset',
      description: 'The Harbor-format tasks a suite selects (`suite`), the tasks under a repository path (`path`), or the tasks of a dataset by name (`dataset`, `version`: built-in `kortix/…` or the Harbor registry), parsed at `ref`, with the dataset README. A task Kortix cannot run carries `unsupported`. Flag `evals`.',
      ...auth,
      request: { params: projectParams, query: z.object({ suite: z.string().optional(), path: z.string().optional(), dataset: z.string().optional(), version: z.string().optional(), ref: z.string().optional() }) },
      responses: { 200: json(EvalTasksResponseSchema, 'The tasks'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'repo');
      if (loaded instanceof Response) return loaded;
      const suite = c.req.query('suite');
      const path = c.req.query('path');
      const dataset = c.req.query('dataset');
      if (!suite && !path && !dataset) return c.json({ error: 'eval_invalid' as const, message: 'Pass `suite`, `path` or `dataset`.' }, 422);
      try {
        return c.json(await evals.listTasks(loaded.row, { suite, path, dataset, version: c.req.query('version'), ref: c.req.query('ref') }), 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/datasets',
      tags: ['evals'],
      summary: 'List the datasets a job can name',
      description:
        'Kortix built-in datasets (`kind: builtin`, `kortix/…`) first, then the Harbor registry (`kind: registry`), each with its versions newest first. A suite names one under `datasets: [{ name, version }]`. ' +
        '`n_tasks` is null when it is not known without reading the dataset. `registry_error` says why the registry is missing from the list. Flag `evals`.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(EvalDatasetsResponseSchema, 'The datasets'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      return c.json(await listEvalDatasets(), 200);
    }),
  );

  const taskParams = projectParams.extend({ taskId: z.string() });
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/tasks/{taskId}',
      tags: ['evals'],
      summary: 'Get one task',
      description: 'A task by its `task_id` (as a task list or a trial returns it): the parsed task, its README, task.toml and every file of its folder with its size. Needs `project.file.read`. Flag `evals`.',
      ...auth,
      request: { params: taskParams },
      responses: { 200: json(EvalTaskDetailResponseSchema, 'The task'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'repo');
      if (loaded instanceof Response) return loaded;
      try {
        return c.json(await evals.taskDetail(loaded.row, c.req.param('taskId') ?? ''), 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/tasks/{taskId}/file',
      tags: ['evals'],
      summary: 'Read one file of a task',
      description: 'The text of a file the task detail lists, by its `path`, as `text/plain` (the first 1 MB). Needs `project.file.read`. Flag `evals`.',
      ...auth,
      request: { params: taskParams, query: z.object({ path: z.string() }) },
      responses: { 200: { description: 'The file' }, ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'repo');
      if (loaded instanceof Response) return loaded;
      try {
        return textFile(await evals.taskFile(loaded.row, c.req.param('taskId') ?? '', c.req.query('path') ?? ''), 300);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/tasks/{taskId}/results',
      tags: ['evals'],
      summary: 'Results of one task across jobs',
      description:
        'The last run of each attempt of this task in the project\u2019s jobs, newest first (up to 200), with its job, agent, model, rewards and error, and per agent \u00d7 model the ended attempts whose reward counts, how many passed and their mean reward. ' +
        'A task is its folder: runs at other commits count. Needs `project.file.read`. Flag `evals`.',
      ...auth,
      request: { params: taskParams },
      responses: { 200: json(EvalTaskResultsResponseSchema, 'The results'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'repo');
      if (loaded instanceof Response) return loaded;
      try {
        return c.json(await evals.taskResults(loaded.row, c.req.param('taskId') ?? ''), 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/compare',
      tags: ['evals'],
      summary: 'Compare eval jobs task by task',
      description:
        '2 to 10 jobs (`jobs`, comma-separated, the baseline first) side by side: one row per task, or per task \u00d7 agent \u00d7 model with `by=task_agent_model` (the default when a job ran several), from the last run of each attempt. ' +
        '`change` compares the last job with the first by pass rate, then mean reward. Flag `evals`.',
      ...auth,
      request: { params: projectParams, query: z.object({ jobs: z.string(), by: z.enum(['task', 'task_agent_model']).optional() }) },
      responses: { 200: json(EvalCompareResponseSchema, 'The comparison'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      const by = c.req.query('by');
      if (by !== undefined && by !== 'task' && by !== 'task_agent_model') return invalid(c, '`by` is `task` or `task_agent_model`.');
      const ids = (c.req.query('jobs') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      try {
        return c.json(await evals.compareJobs(loaded.row, ids, by), 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/jobs',
      tags: ['evals'],
      summary: 'List eval jobs',
      description:
        'The jobs of a project, newest first, each with its stats. Filters: `status`, `suite`, `dataset` (a dataset name of the config), `agent`, `model` (named in the config or run by a trial), `q` (part of the job name). ' +
        '`limit` is 1 to 200 (default 50). `cursor` is `next_cursor` of the page before. `total` counts every match. Flag `evals`.',
      ...auth,
      request: {
        params: projectParams,
        query: z.object({
          status: z.string().optional(),
          suite: z.string().optional(),
          dataset: z.string().optional(),
          agent: z.string().optional(),
          model: z.string().optional(),
          q: z.string().optional(),
          limit: z.string().optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: { 200: json(EvalJobListResponseSchema, 'The jobs'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      const rawLimit = c.req.query('limit');
      const limit = rawLimit === undefined ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return invalid(c, '`limit` is an integer from 1 to 200.');
      const status = c.req.query('status');
      if (status !== undefined && !(EVAL_JOB_STATUSES as readonly string[]).includes(status)) return invalid(c, `\`status\` is one of ${EVAL_JOB_STATUSES.join(', ')}.`);
      const cursor = c.req.query('cursor');
      let after: string | undefined;
      if (cursor) {
        const id = Buffer.from(cursor, 'base64url').toString('utf8');
        if (!isUuid(id) || !(await getJob(loaded.row.projectId, id))) return invalid(c, '`cursor` is not a page of this list. Start again without it.');
        after = id;
      }
      const filters: EvalJobFilters = {
        status: status as EvalJobStatus | undefined,
        suite: c.req.query('suite') || undefined,
        dataset: c.req.query('dataset') || undefined,
        agent: c.req.query('agent') || undefined,
        model: c.req.query('model') || undefined,
        q: c.req.query('q') || undefined,
      };
      const [rows, total] = await Promise.all([listJobs(loaded.row.projectId, { ...filters, limit: limit + 1, after }), countJobs(loaded.row.projectId, filters)]);
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? Buffer.from(page[page.length - 1]!.jobId).toString('base64url') : null;
      return c.json({ jobs: page.map(serializeJob), next_cursor: next, total }, 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/evals/jobs',
      tags: ['evals'],
      summary: 'Start an eval job',
      description:
        'Plans tasks × agents × attempts at `ref` and queues one trial for each. `suite` names a suite of `evals:`; `config` overrides its fields, or is the whole job config when no suite is named. ' +
        'Each trial runs in its own session and sandbox, as the caller: the agent gets the task\'s instruction, then `tests/test.sh` runs and writes the reward. ' +
        '`dry_run: true` answers `200` with what would run and creates nothing. `warnings` names what the config reader ignored. An `Idempotency-Key` replay answers `200` with the first job. Needs `project.session.start`. Flag `evals`.',
      ...auth,
      request: { params: projectParams, body: { content: { 'application/json': { schema: lenientBody(CreateEvalJobRequestSchema.shape) } } } },
      responses: {
        200: json(z.union([EvalJobResponseSchema, EvalJobPlanResponseSchema]), 'The plan (dry run), or the job an Idempotency-Key replay returns'),
        201: json(EvalJobResponseSchema, 'The job'),
        503: json(EvalErrorSchema, 'eval_unavailable'),
        ...errors(400),
        ...EVAL_ERRORS,
      },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'run');
      if (loaded instanceof Response) return loaded;
      const body = await parseBody(c, CreateEvalJobRequestSchema);
      if (body instanceof Response) return body;
      if (!body.suite && !body.config) return invalid(c, 'Pass `suite`, `config`, or both.');
      try {
        if (body.dry_run) return c.json(await evals.planJob(loaded.row, body), 200);
        if (!driveStorageAvailable()) return c.json({ error: 'eval_unavailable' as const, message: 'Evals keep their results in Files, and this deployment has no Files storage.' }, 503);
        const key = idempotencyKeyOf(c);
        if (key instanceof Response) return key;
        const created = await evals.createJob(loaded.row, await requesterOf(c, loaded, key), body);
        return c.json({ job: serializeJob(created.job), warnings: created.warnings }, created.replayed ? 200 : 201);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/jobs/{jobId}',
      tags: ['evals'],
      summary: 'Get an eval job',
      description: 'The job with its config and its stats: counts per trial status, and per agent and model the metrics over the valid rewards. Flag `evals`.',
      ...auth,
      request: { params: jobParams },
      responses: { 200: json(EvalJobResponseSchema, 'The job'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      const job = await jobOf(c, loaded);
      return job ? c.json({ job: serializeJob(job) }, 200) : notFound(c);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/jobs/{jobId}/trials',
      tags: ['evals'],
      summary: 'List the trials of an eval job',
      description: 'Every trial of the job, by task, agent and attempt. A retry of an attempt is its own trial with `retry` above 0. Flag `evals`.',
      ...auth,
      request: { params: jobParams },
      responses: { 200: json(EvalTrialListResponseSchema, 'The trials'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      const job = await jobOf(c, loaded);
      if (!job) return notFound(c);
      return c.json({ trials: (await listTrials(job.jobId)).map((trial) => serializeTrial(job, trial)) }, 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/jobs/{jobId}/trials/{trialId}',
      tags: ['evals'],
      summary: 'Get one trial',
      description: 'The trial, the instruction its agent got (null without `project.file.read`: it is repository content), and the files of its folder (`result.json`, `verifier/test-stdout.txt`, …). Flag `evals`.',
      ...auth,
      request: { params: trialParams },
      responses: { 200: json(EvalTrialDetailResponseSchema, 'The trial'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      try {
        return c.json(await evals.trialDetail(loaded.row, c.req.param('jobId') ?? '', c.req.param('trialId') ?? '', await canReadRepo(c, loaded)), 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/evals/jobs/{jobId}/trials/{trialId}/file',
      tags: ['evals'],
      summary: 'Read one file of a trial folder',
      description: 'A file the trial detail lists, by its `path`, as `text/plain` exactly as written (the first 1 MB): a `reward.json` that does not parse reads back as it is. Flag `evals`.',
      ...auth,
      request: { params: trialParams, query: z.object({ path: z.string() }) },
      responses: { 200: { description: 'The file' }, ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c);
      if (loaded instanceof Response) return loaded;
      const found = await evals.trialOf(loaded.row, c.req.param('jobId') ?? '', c.req.param('trialId') ?? '');
      const path = c.req.query('path') ?? '';
      if (!found || !path || path.startsWith('/') || path.split('/').includes('..')) return notFound(c);
      const file = await readEvalFile(found.job.driveId, `${trialFolder(found.job.folder, found.trial.trialName)}/${path}`);
      if (!file || !file.ok) return notFound(c);
      const bytes = new Uint8Array(await file.arrayBuffer());
      return textFile(bytes.byteLength > FILE_BYTES_MAX ? bytes.subarray(0, FILE_BYTES_MAX) : bytes, 60);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/evals/jobs/{jobId}/cancel',
      tags: ['evals'],
      summary: 'Cancel an eval job',
      description: 'No queued trial starts, and every running trial ends `cancelled` with its sandbox stopped. A job that ended stays as it is. Needs `project.session.start`. Flag `evals`.',
      ...auth,
      request: { params: jobParams },
      responses: { 200: json(EvalJobResponseSchema, 'The job'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'run');
      if (loaded instanceof Response) return loaded;
      try {
        return c.json({ job: serializeJob(await evals.cancelJob(loaded.row, c.req.param('jobId') ?? '')) }, 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/evals/jobs/{jobId}/rerun',
      tags: ['evals'],
      summary: 'Run trials of a job again',
      description:
        'Starts a new job at the same commit and config with the trials `scope` selects (`all`, `failed`: reward below 1 or none, `errored`: ended with an exception) or the named `trial_ids`. `rerun_of` of the new job names this one. ' +
        'A job that has not ended answers `409 eval_conflict`: retry one trial inside it instead. An `Idempotency-Key` replay answers `200` with the first new job. Needs `project.session.start`. Flag `evals`.',
      ...auth,
      request: { params: jobParams, body: { content: { 'application/json': { schema: lenientBody(RerunEvalJobRequestSchema.shape) } } } },
      responses: { 200: json(EvalJobResponseSchema, 'The job an Idempotency-Key replay returns'), 201: json(EvalJobResponseSchema, 'The new job'), 503: json(EvalErrorSchema, 'eval_unavailable'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'run');
      if (loaded instanceof Response) return loaded;
      if (!driveStorageAvailable()) return c.json({ error: 'eval_unavailable' as const, message: 'Evals keep their results in Files, and this deployment has no Files storage.' }, 503);
      const body = await parseBody(c, RerunEvalJobRequestSchema);
      if (body instanceof Response) return body;
      const key = idempotencyKeyOf(c);
      if (key instanceof Response) return key;
      try {
        const rerun = await evals.rerunJob(loaded.row, await requesterOf(c, loaded, key), c.req.param('jobId') ?? '', body);
        return c.json({ job: serializeJob(rerun.job) }, rerun.replayed ? 200 : 201);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/evals/jobs/{jobId}/trials/{trialId}/retry',
      tags: ['evals'],
      summary: 'Run one trial again inside its job',
      description:
        'Queues a new run of the trial\u2019s attempt (`retry` + 1) in the same job; it supersedes this run in every count. An ended job runs again until the new run ends. ' +
        'The trial must have ended and be the last run of its attempt, else `409 eval_conflict`. An `Idempotency-Key` replay answers `200` with the first new run. Needs `project.session.start`. Flag `evals`.',
      ...auth,
      request: { params: trialParams },
      responses: { 200: json(EvalTrialResponseSchema, 'The run an Idempotency-Key replay returns'), 201: json(EvalTrialResponseSchema, 'The new run'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'run');
      if (loaded instanceof Response) return loaded;
      const key = idempotencyKeyOf(c);
      if (key instanceof Response) return key;
      try {
        const jobId = c.req.param('jobId') ?? '';
        const retried = await evals.retryTrial(loaded.row, jobId, c.req.param('trialId') ?? '', key);
        const job = await getJob(loaded.row.projectId, jobId);
        return c.json({ trial: serializeTrial(job!, retried.trial) }, retried.replayed ? 200 : 201);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/evals/jobs/{jobId}/trials/{trialId}/cancel',
      tags: ['evals'],
      summary: 'Cancel one trial',
      description: 'A queued or running trial ends `cancelled` and its sandbox stops; the rest of the job runs on. A trial that ended stays as it is. Needs `project.session.start`. Flag `evals`.',
      ...auth,
      request: { params: trialParams },
      responses: { 200: json(EvalTrialResponseSchema, 'The trial'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'run');
      if (loaded instanceof Response) return loaded;
      try {
        const jobId = c.req.param('jobId') ?? '';
        const trial = await evals.cancelOneTrial(loaded.row, jobId, c.req.param('trialId') ?? '');
        const job = await getJob(loaded.row.projectId, jobId);
        return c.json({ trial: serializeTrial(job!, trial) }, 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/evals/jobs/{jobId}',
      tags: ['evals'],
      summary: 'Delete an eval job',
      description: 'Deletes an ended job: its trials and its folder in Files. The sessions its trials ran in stay. A running job answers `409 eval_conflict`: cancel it first. Needs project write access. Flag `evals`.',
      ...auth,
      request: { params: jobParams },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Deleted'), ...errors(400), ...EVAL_ERRORS },
    }),
    handler(async (c) => {
      const loaded = await scopeOf(c, 'admin');
      if (loaded instanceof Response) return loaded;
      try {
        await evals.removeJob(loaded.row, c.req.param('jobId') ?? '');
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    }),
  );
}
