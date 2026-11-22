/**
 * Evals — Harbor-format tasks scored per agent (`/v1/projects/:projectId/evals/*`,
 * flag `evals`). Spec: tests/spec/end-to-end.md § 12e Evals. Source of truth:
 * apps/api/src/projects/routes/evals.ts + apps/api/src/projects/evals/.
 *
 * The local profile runs no sandbox and no Drive storage. These flows cover
 * what runs without one: the flag gate, suites (inline and a Harbor job
 * config file), task parsing, task pages (detail, files, results), the
 * repository-read gate, validation, dry runs, job planning (tasks × agents ×
 * attempts), idempotent starts, job filters and paging, compare, cancel and
 * retry of one trial, cancel, re-run and delete. A trial worked by a real sandbox and
 * graded by tests/test.sh needs the `sandbox` capability and is not part of
 * these flows.
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const R = {
  suites: '/v1/projects/:projectId/evals',
  tasks: '/v1/projects/:projectId/evals/tasks',
  jobs: '/v1/projects/:projectId/evals/jobs',
  job: '/v1/projects/:projectId/evals/jobs/:jobId',
  trials: '/v1/projects/:projectId/evals/jobs/:jobId/trials',
  cancel: '/v1/projects/:projectId/evals/jobs/:jobId/cancel',
  rerun: '/v1/projects/:projectId/evals/jobs/:jobId/rerun',
  task: '/v1/projects/:projectId/evals/tasks/:taskId',
  taskFile: '/v1/projects/:projectId/evals/tasks/:taskId/file',
  taskResults: '/v1/projects/:projectId/evals/tasks/:taskId/results',
  datasets: '/v1/projects/:projectId/evals/datasets',
  compare: '/v1/projects/:projectId/evals/compare',
  trialRetry: '/v1/projects/:projectId/evals/jobs/:jobId/trials/:trialId/retry',
  trialCancel: '/v1/projects/:projectId/evals/jobs/:jobId/trials/:trialId/cancel',
  trial: '/v1/projects/:projectId/evals/jobs/:jobId/trials/:trialId',
  trialFile: '/v1/projects/:projectId/evals/jobs/:jobId/trials/:trialId/file',
} as const;

const TASK_TOML = '[agent]\ntimeout_sec = 120.0\n\n[verifier]\ntimeout_sec = 30.0\nenvironment_mode = "shared"\n';
const task = (name: string, extra: Record<string, string> = {}) => ({
  [`evals/tasks/${name}/task.toml`]: TASK_TOML,
  [`evals/tasks/${name}/instruction.md`]: `<!-- canary -->\nCreate /var/tmp/${name}.txt.\n`,
  [`evals/tasks/${name}/tests/test.sh`]: `#!/bin/bash\n[ -f /var/tmp/${name}.txt ] && echo 1 > /logs/verifier/reward.txt || echo 0 > /logs/verifier/reward.txt\n`,
  [`evals/tasks/${name}/solution/solve.sh`]: `#!/bin/bash\ntouch /var/tmp/${name}.txt\n`,
  ...extra,
});
const MANIFEST = `project:
  name: ke2e-evals
default_agent: kortix
agents:
  kortix:
    kortix_permissions: all
evals:
  smoke:
    tasks: evals/tasks
    agents: [oracle, nop]
    n_attempts: 2
  harbor:
    config: evals/harbor.yaml
  broken:
    tasks: evals/missing
    agents: [kortix]
  image:
    tasks: evals/images
    agents: [oracle]
`;
// A task with its own image: the first job that runs it makes a project sandbox template.
const IMAGE_TASK = {
  'evals/images/pinned/task.toml': `${TASK_TOML}\n[environment]\ndocker_image = "ubuntu:24.04"\n`,
  'evals/images/pinned/instruction.md': 'Create /var/tmp/pinned.txt.\n',
  'evals/images/pinned/tests/test.sh': '#!/bin/bash\necho 1 > /logs/verifier/reward.txt\n',
};
const HARBOR_CONFIG = 'jobs_dir: jobs\nn_attempts: 1\nenvironment:\n  type: docker\nagents:\n  - name: kortix\ndatasets:\n  - path: evals/tasks\n';

interface Job {
  job_id: string;
  job_name: string;
  status: string;
  suite: string | null;
  commit: string | null;
  rerun_of: string | null;
  stats: { n_total_trials: number; n_queued: number; n_cancelled: number };
}

async function openWorld(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  // An account member: reads scores, has no `project.file.read`.
  const member = await team.addMember('member');
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  await world.commitToMain(
    { 'kortix.yaml': MANIFEST, 'evals/harbor.yaml': HARBOR_CONFIG, ...task('alpha'), ...task('beta'), ...IMAGE_TASK, 'evals/tasks/not-a-task/README.md': 'no task.toml here\n' },
    'ke2e: eval tasks',
  );
  await world.setFeature('evals', true);
  return { project, world, owner: ctx.client.as(ctx.P.OWNER), member: ctx.client.as(member) };
}

function expectError(r: { statusCode: number; json<T>(): T; text(): string }, status: number, code: string) {
  if (r.statusCode !== status) throw new Error(`expected ${status} ${code}, got ${r.statusCode}: ${r.text()}`);
  const body = r.json<{ error?: string; code?: string }>();
  if (body.error !== code && body.code !== code) throw new Error(`expected ${code}, got ${r.text()}`);
}

flow(
  'EVAL-1',
  {
    domain: 'evals',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [
      `GET ${R.suites}`,
      `GET ${R.tasks}`,
      `GET ${R.jobs}`,
      `POST ${R.jobs}`,
      `GET ${R.job}`,
      `DELETE ${R.job}`,
      `GET ${R.trials}`,
      `POST ${R.cancel}`,
      `POST ${R.rerun}`,
      `GET ${R.task}`,
      `GET ${R.taskFile}`,
      `GET ${R.taskResults}`,
      `GET ${R.datasets}`,
      `GET ${R.compare}`,
      `POST ${R.trialRetry}`,
      `POST ${R.trialCancel}`,
      `GET ${R.trial}`,
      `GET ${R.trialFile}`,
      'PATCH /v1/projects/:projectId/features',
    ],
  },
  async (ctx) => {
    const { project, world, owner, member } = await openWorld(ctx);
    const params = { projectId: project.id };

    await ctx.step('an anonymous caller → 401; the flag off → 403 feature_disabled on read and start; on again → 200', async () => {
      (await ctx.client.as(ctx.P.ANON).get(R.suites, { params })).status(401);
      await world.setFeature('evals', false);
      expectError(await owner.get(R.suites, { params }), 403, 'feature_disabled');
      expectError(await owner.post(R.jobs, { suite: 'smoke' }, { params }), 403, 'feature_disabled');
      await world.setFeature('evals', true);
      (await owner.get(R.suites, { params })).status(200);
    });

    await ctx.step('suites: inline and Harbor config resolve, ignored Harbor fields warn, a missing path is the job’s error', async () => {
      const suites = (await owner.get(R.suites, { params })).status(200).json<{ suites: Array<{ name: string; source: string; config: { n_attempts: number; agents: Array<{ name: string }> } | null; error: string | null; warnings: string[] }> }>().suites;
      const byName = new Map(suites.map((s) => [s.name, s]));
      const smoke = byName.get('smoke');
      if (!smoke?.config || smoke.source !== 'inline' || smoke.config.n_attempts !== 2 || smoke.config.agents.map((a) => a.name).join() !== 'oracle,nop') throw new Error(JSON.stringify(smoke));
      const harbor = byName.get('harbor');
      if (!harbor?.config || harbor.source !== 'config' || harbor.config.agents[0]?.name !== 'kortix') throw new Error(JSON.stringify(harbor));
      if (!harbor.warnings.some((w) => w.includes('jobs_dir')) || !harbor.warnings.some((w) => w.includes('environment.type'))) throw new Error(`warnings ${JSON.stringify(harbor.warnings)}`);
      if (!byName.get('broken')?.config) throw new Error('broken suite should resolve its config; its path fails at job start');
    });

    await ctx.step('tasks of a suite: parsed from task.toml and instruction.md; a folder without task.toml is not listed', async () => {
      const body = (await owner.get(R.tasks, { params, query: { suite: 'smoke' } })).status(200).json<{ commit: string; tasks: Array<{ name: string; instruction: string; agent_timeout_sec: number; verifier_timeout_sec: number; has_solution: boolean; unsupported: string | null }> }>();
      if (body.tasks.map((t) => t.name).join() !== 'alpha,beta') throw new Error(JSON.stringify(body.tasks.map((t) => t.name)));
      const alpha = body.tasks[0]!;
      if (alpha.instruction !== 'Create /var/tmp/alpha.txt.' || alpha.agent_timeout_sec !== 120 || alpha.verifier_timeout_sec !== 30 || !alpha.has_solution || alpha.unsupported) throw new Error(JSON.stringify(alpha));
    });

    let taskId = '';
    await ctx.step('a task by its task_id: its files with sizes, one file as text/plain, no results yet; a forged id → 404', async () => {
      taskId = (await owner.get(R.tasks, { params, query: { suite: 'smoke' } })).status(200).json<{ tasks: Array<{ task_id: string }> }>().tasks[0]!.task_id;
      const detail = (await owner.get(R.task, { params: { ...params, taskId } })).status(200).json<{ task: { name: string }; files: Array<{ path: string; size: number }>; task_toml: string }>();
      const test = detail.files.find((f) => f.path === 'tests/test.sh');
      if (detail.task.name !== 'alpha' || !test || test.size <= 0 || !detail.task_toml.includes('timeout_sec')) throw new Error(JSON.stringify(detail));
      const file = (await owner.get(R.taskFile, { params: { ...params, taskId }, query: { path: 'tests/test.sh' } })).status(200);
      if (!file.text().startsWith('#!/bin/bash') || !String(file.header('content-type') ?? '').startsWith('text/plain')) throw new Error(file.text());
      const results = (await owner.get(R.taskResults, { params: { ...params, taskId } })).status(200).json<{ results: unknown[]; summary: unknown[] }>();
      if (results.results.length !== 0 || results.summary.length !== 0) throw new Error(JSON.stringify(results));
      // The unsigned shape of an id names another repository: the API fetches nothing and answers 404.
      const forged = Buffer.from(JSON.stringify({ k: 'git', p: 'x', c: 'a'.repeat(40), u: 'https://github.com/example/huge.git' })).toString('base64url');
      expectError(await owner.get(R.task, { params: { ...params, taskId: forged } }), 404, 'eval_not_found');
      expectError(await owner.get(R.task, { params: { ...params, taskId: `${forged}~${taskId.split('~')[1]}` } }), 404, 'eval_not_found');
    });

    await ctx.step('a member without project.file.read: suites and jobs → 200; tasks, a task, its file and its results → 403', async () => {
      (await member.get(R.suites, { params })).status(200);
      (await member.get(R.jobs, { params })).status(200);
      (await member.get(R.tasks, { params, query: { suite: 'smoke' } })).status(403);
      (await member.get(R.task, { params: { ...params, taskId } })).status(403);
      (await member.get(R.taskFile, { params: { ...params, taskId }, query: { path: 'tests/test.sh' } })).status(403);
      (await member.get(R.taskResults, { params: { ...params, taskId } })).status(403);
    });

    await ctx.step('a member without project.sandbox.write starts a task whose image has no template yet → 403 eval_forbidden, no job', async () => {
      const before = (await owner.get(R.jobs, { params })).status(200).json<{ total: number }>().total;
      expectError(await member.post(R.jobs, { suite: 'image' }, { params }), 403, 'eval_forbidden');
      const after = (await owner.get(R.jobs, { params })).status(200).json<{ total: number }>().total;
      if (after !== before) throw new Error(`a refused start created a job: ${before} → ${after}`);
    });

    await ctx.step('the dataset catalog lists the built-in dataset first, with its kind and versions', async () => {
      const body = (await owner.get(R.datasets, { params })).status(200).json<{ datasets: Array<{ name: string; kind: string; versions: string[] }>; registry_error: string | null }>();
      const first = body.datasets[0];
      if (first?.name !== 'kortix/my-kortix' || first.kind !== 'builtin' || first.versions.length !== 1) throw new Error(JSON.stringify(body.datasets.slice(0, 2)));
    });

    await ctx.step('dry_run → 200 with tasks, trials and the ignored-key warning; no job is created', async () => {
      const plan = (await owner.post(R.jobs, { suite: 'smoke', dry_run: true, config: { agents: ['oracle'], jobs_dir: 'x' } }, { params })).status(200).json<{ n_tasks: number; n_trials: number; tasks: string[]; warnings: string[] }>();
      if (plan.n_tasks !== 2 || plan.n_trials !== 4 || plan.tasks.join() !== 'alpha,beta' || !plan.warnings.some((w) => w.includes('jobs_dir'))) throw new Error(JSON.stringify(plan));
      if ((await owner.get(R.jobs, { params })).json<{ total: number }>().total !== 0) throw new Error('a dry run created a job');
    });

    await ctx.step('invalid starts → 422 eval_invalid with violations and no job: unknown suite, unknown agent, a path with no task', async () => {
      const unknownSuite = await owner.post(R.jobs, { suite: 'nope' }, { params });
      expectError(unknownSuite, 422, 'eval_invalid');
      expectError(await owner.post(R.jobs, { suite: 'smoke', config: { agents: [{ name: 'ghost' }] } }, { params }), 422, 'eval_invalid');
      const missing = await owner.post(R.jobs, { suite: 'broken' }, { params });
      expectError(missing, 422, 'eval_invalid');
      if (!missing.json<{ violations?: string[] }>().violations?.some((v) => v.includes('evals/missing'))) throw new Error(missing.text());
      const jobs = (await owner.get(R.jobs, { params })).json<{ jobs: Job[] }>().jobs;
      if (jobs.length !== 0) throw new Error(`expected no job, got ${jobs.length}`);
    });

    let job: Job | null = null;
    await ctx.step('start smoke → 201 queued, 2 tasks × 2 agents × 2 attempts = 8 trials at the default branch commit', async () => {
      job = (await owner.post(R.jobs, { suite: 'smoke' }, { params })).status(201).json<{ job: Job }>().job;
      if (job.status !== 'queued' || job.suite !== 'smoke' || !/^[0-9a-f]{40}$/.test(job.commit ?? '') || job.stats.n_total_trials !== 8) throw new Error(JSON.stringify(job));
      const trials = (await owner.get(R.trials, { params: { ...params, jobId: job.job_id } })).status(200).json<{ trials: Array<{ trial_name: string; status: string }> }>().trials;
      const names = trials.map((t) => t.trial_name).sort();
      if (names.length !== 8 || names[0] !== 'alpha__nop__1' || names[7] !== 'beta__oracle__2' || trials.some((t) => t.status !== 'queued')) throw new Error(JSON.stringify(names));
    });

    await ctx.step('an Idempotency-Key replay → 200 with the same job; the key with another body → 409 eval_conflict', async () => {
      const headers = { 'Idempotency-Key': `ke2e-${project.id}` };
      const body = { suite: 'smoke', config: { agents: [{ name: 'nop' }], n_attempts: 1, job_name: 'idem' } };
      const first = (await owner.post(R.jobs, body, { params, headers })).status(201).json<{ job: Job }>().job;
      const replay = (await owner.post(R.jobs, body, { params, headers })).status(200).json<{ job: Job }>().job;
      if (replay.job_id !== first.job_id) throw new Error(`${replay.job_id} != ${first.job_id}`);
      expectError(await owner.post(R.jobs, { ...body, config: { ...body.config, n_attempts: 2 } }, { params, headers }), 409, 'eval_conflict');
      (await owner.post(R.cancel, {}, { params: { ...params, jobId: first.job_id } })).status(200);
    });

    await ctx.step('a config override layers over the suite: one agent, one attempt → 2 trials; the suite’s tasks stay', async () => {
      const small = (await owner.post(R.jobs, { suite: 'smoke', config: { agents: [{ name: 'oracle' }], n_attempts: 1, job_name: 'oracle-once' } }, { params })).status(201).json<{ job: Job }>().job;
      if (small.job_name !== 'oracle-once' || small.stats.n_total_trials !== 2) throw new Error(JSON.stringify(small));
      // The same name again gets a suffix, not a conflict.
      const again = (await owner.post(R.jobs, { suite: 'smoke', config: { agents: [{ name: 'oracle' }], n_attempts: 1, job_name: 'oracle-once' } }, { params })).status(201).json<{ job: Job }>().job;
      if (again.job_name !== 'oracle-once-2') throw new Error(again.job_name);
    });

    await ctx.step('job filters narrow the list and total counts them; pages walk every job once; a bad limit, status or cursor → 422', async () => {
      const list = (query: Record<string, string>) => owner.get(R.jobs, { params, query });
      const all = (await list({})).status(200).json<{ jobs: Job[]; total: number }>();
      if (all.total !== 4 || all.jobs.length !== 4) throw new Error(`total ${all.total}`);
      if ((await list({ q: 'oracle-once' })).json<{ total: number }>().total !== 2) throw new Error('q');
      if ((await list({ agent: 'nop' })).json<{ total: number }>().total !== 2) throw new Error('agent');
      if ((await list({ status: 'cancelled' })).json<{ total: number }>().total !== 1) throw new Error('status');
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { jobs: Job[]; next_cursor: string | null } = (await list({ limit: '1', ...(cursor ? { cursor } : {}) })).status(200).json();
        seen.push(...page.jobs.map((j) => j.job_id));
        cursor = page.next_cursor;
      } while (cursor);
      if (seen.join() !== all.jobs.map((j) => j.job_id).join()) throw new Error(`paged ${seen.length} of ${all.jobs.length}`);
      for (const query of [{ limit: 'abc' }, { limit: '0' }, { status: 'done' }, { cursor: 'bm9wZQ' }] as Array<Record<string, string>>) expectError(await list(query), 422, 'eval_invalid');
    });

    await ctx.step('compare two jobs task by task → one row per task; one job or an unknown job → 422 / 404', async () => {
      const ids = (await owner.get(R.jobs, { params, query: { q: 'oracle-once' } })).json<{ jobs: Job[] }>().jobs.map((j) => j.job_id);
      const result = (await owner.get(R.compare, { params, query: { jobs: ids.join(',') } })).status(200).json<{ by: string; rows: Array<{ task_name: string; cells: unknown[]; change: string }>; summary: { same: number } }>();
      if (result.by !== 'task' || result.rows.map((r) => r.task_name).join() !== 'alpha,beta' || result.rows.some((r) => r.cells.length !== 2) || result.summary.same !== 2) throw new Error(JSON.stringify(result));
      expectError(await owner.get(R.compare, { params, query: { jobs: ids[0]! } }), 422, 'eval_invalid');
      expectError(await owner.get(R.compare, { params, query: { jobs: `${ids[0]},00000000-0000-4000-8000-000000000000` } }), 404, 'eval_not_found');
    });

    await ctx.step('one trial: retry while queued → 409; cancel → cancelled; retry → 201 a new run (retry 1) that replaces it', async () => {
      const jobId = job!.job_id;
      const trials = (await owner.get(R.trials, { params: { ...params, jobId } })).json<{ trials: Array<{ trial_id: string; trial_name: string }> }>().trials;
      const first = trials.find((t) => t.trial_name === 'alpha__oracle__1')!;
      const trialParams = { ...params, jobId, trialId: first.trial_id };
      expectError(await owner.post(R.trialRetry, {}, { params: trialParams }), 409, 'eval_conflict');
      const cancelled = (await owner.post(R.trialCancel, {}, { params: trialParams })).status(200).json<{ trial: { status: string } }>().trial;
      if (cancelled.status !== 'cancelled') throw new Error(JSON.stringify(cancelled));
      const retried = (await owner.post(R.trialRetry, {}, { params: trialParams })).status(201).json<{ trial: { trial_name: string; retry: number; status: string } }>().trial;
      if (retried.trial_name !== 'alpha__oracle__1__r1' || retried.retry !== 1 || retried.status !== 'queued') throw new Error(JSON.stringify(retried));
      const after = (await owner.get(R.job, { params: { ...params, jobId } })).json<{ job: Job & { stats: { n_retries: number } } }>().job;
      if (after.stats.n_total_trials !== 8 || after.stats.n_retries !== 1) throw new Error(JSON.stringify(after.stats));
    });

    await ctx.step('a trial: the owner reads its instruction, a member without file read gets null; a file it never wrote or a ../ path → 404', async () => {
      const jobId = job!.job_id;
      const trialId = (await owner.get(R.trials, { params: { ...params, jobId } })).json<{ trials: Array<{ trial_id: string }> }>().trials[0]!.trial_id;
      const trialParams = { ...params, jobId, trialId };
      const mine = (await owner.get(R.trial, { params: trialParams })).status(200).json<{ trial: { task_id: string | null }; instruction: string | null }>();
      if (!mine.instruction?.startsWith('Create /var/tmp/') || !mine.trial.task_id?.includes('~')) throw new Error(JSON.stringify(mine));
      const theirs = (await member.get(R.trial, { params: trialParams })).status(200).json<{ instruction: string | null }>();
      if (theirs.instruction !== null) throw new Error('a member without project.file.read read the instruction');
      expectError(await owner.get(R.trialFile, { params: trialParams, query: { path: 'result.json' } }), 404, 'eval_not_found');
      expectError(await owner.get(R.trialFile, { params: trialParams, query: { path: '../config.json' } }), 404, 'eval_not_found');
    });

    await ctx.step('an id that is no UUID → 404 eval_not_found on read, cancel, re-run, delete and a trial action', async () => {
      expectError(await owner.get(R.job, { params: { ...params, jobId: 'nope' } }), 404, 'eval_not_found');
      expectError(await owner.post(R.cancel, {}, { params: { ...params, jobId: 'nope' } }), 404, 'eval_not_found');
      expectError(await owner.post(R.rerun, {}, { params: { ...params, jobId: 'nope' } }), 404, 'eval_not_found');
      expectError(await owner.del(R.job, { params: { ...params, jobId: 'nope' } }), 404, 'eval_not_found');
      expectError(await owner.post(R.trialCancel, {}, { params: { ...params, jobId: job!.job_id, trialId: 'nope' } }), 404, 'eval_not_found');
    });

    await ctx.step('delete of a queued job → 409 eval_conflict; cancel → cancelled, every trial cancelled', async () => {
      const jobId = job!.job_id;
      expectError(await owner.del(R.job, { params: { ...params, jobId } }), 409, 'eval_conflict');
      const cancelled = (await owner.post(R.cancel, {}, { params: { ...params, jobId } })).status(200).json<{ job: Job }>().job;
      if (cancelled.status !== 'cancelled' || cancelled.stats.n_cancelled !== 8 || cancelled.stats.n_queued !== 0) throw new Error(JSON.stringify(cancelled));
    });

    await ctx.step('re-run all → a new queued job at the same commit with rerun_of set and the same 8 trials', async () => {
      // A re-run of a job that has not ended is refused: the queued `idem`-free job above is still open.
      const open = (await owner.post(R.jobs, { suite: 'smoke', config: { agents: [{ name: 'nop' }], n_attempts: 1 } }, { params })).status(201).json<{ job: Job }>().job;
      expectError(await owner.post(R.rerun, { scope: 'all' }, { params: { ...params, jobId: open.job_id } }), 409, 'eval_conflict');
      (await owner.post(R.cancel, {}, { params: { ...params, jobId: open.job_id } })).status(200);
      const next = (await owner.post(R.rerun, { scope: 'all' }, { params: { ...params, jobId: job!.job_id } })).status(201).json<{ job: Job }>().job;
      if (next.rerun_of !== job!.job_id || next.commit !== job!.commit || next.stats.n_total_trials !== 8 || next.status !== 'queued') throw new Error(JSON.stringify(next));
      (await owner.post(R.cancel, {}, { params: { ...params, jobId: next.job_id } })).status(200);
    });

    await ctx.step('delete an ended job → 200; it reads 404 eval_not_found after', async () => {
      const jobId = job!.job_id;
      (await owner.del(R.job, { params: { ...params, jobId } })).status(200);
      expectError(await owner.get(R.job, { params: { ...params, jobId } }), 404, 'eval_not_found');
    });
  },
);
