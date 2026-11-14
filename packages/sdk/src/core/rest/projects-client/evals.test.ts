import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  cancelWorkspaceEvalJob,
  cancelWorkspaceEvalTrial,
  compareWorkspaceEvalJobs,
  deleteWorkspaceEvalJob,
  evalJobScore,
  evalTrialScore,
  getWorkspaceEvalJob,
  getWorkspaceEvalTask,
  getWorkspaceEvalTrial,
  listWorkspaceEvalDatasets,
  listWorkspaceEvalTaskResults,
  listWorkspaceEvalJobs,
  listWorkspaceEvalSuites,
  listWorkspaceEvalTasks,
  listWorkspaceEvalTrials,
  readWorkspaceEvalTaskFile,
  readWorkspaceEvalTrialFile,
  planWorkspaceEvalJob,
  rerunWorkspaceEvalJob,
  retryWorkspaceEvalTrial,
  startWorkspaceEvalJob,
  type WorkspaceEvalJob,
  type WorkspaceEvalTrial,
} from './evals';

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

type Call = { method: string; key: string; body: unknown; idempotencyKey: string | null };

function serve(routes: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const raw = init.body != null ? await new Response(init.body as BodyInit).text() : '';
    const headers = new Headers(init.headers ?? request?.headers);
    calls.push({ method, key, body: raw ? JSON.parse(raw) : null, idempotencyKey: headers.get('idempotency-key') });
    const route = routes[key] ?? { status: 404, body: { error: 'eval_not_found', message: 'Not found.' } };
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status, headers: { 'content-type': typeof route.body === 'string' ? 'text/plain' : 'application/json' } });
  }) as unknown as typeof fetch;
}

const STATS = {
  n_total_trials: 4,
  n_queued: 0,
  n_running: 0,
  n_completed: 3,
  n_errored: 1,
  n_cancelled: 0,
  n_retries: 0,
  exception_stats: { AgentTimeoutError: 1 },
  usage: null,
  agents: [{ agent: 'worker', model: 'p/m', source: null, n_trials: 3, n_errors: 1, metrics: [{ mean: 0.6667 }], pass_at_k: { '1': 0.5 } }],
};
const JOB = {
  job_id: 'j1',
  project_id: 'p1',
  suite: 'smoke',
  job_name: 'smoke-1',
  status: 'completed',
  commit: 'abc',
  ref: null,
  config: { n_attempts: 1 },
  stats: STATS,
  rerun_of: null,
  folder: '/Evals/smoke-1',
  drive_id: 'd1',
  created_by: 'u1',
  created_at: '2026-11-13T00:00:00Z',
  started_at: null,
  finished_at: null,
} as unknown as WorkspaceEvalJob;

describe('evals client', () => {
  let calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(routes)) delete routes[key];
    serve(routes, calls);
  });

  test('suites, tasks and jobs read their routes', async () => {
    routes['GET /workspaces/p1/evals'] = { status: 200, body: { suites: [{ name: 'smoke' }] } };
    routes['GET /workspaces/p1/evals/tasks?suite=smoke'] = { status: 200, body: { commit: 'abc', tasks: [{ name: 't1' }] } };
    routes['GET /workspaces/p1/evals/jobs?suite=smoke&limit=5'] = { status: 200, body: { jobs: [JOB], next_cursor: null } };
    expect((await listWorkspaceEvalSuites('p1')).map((s) => s.name)).toEqual(['smoke']);
    expect((await listWorkspaceEvalTasks('p1', { suite: 'smoke' })).tasks.map((t) => t.name)).toEqual(['t1']);
    expect((await listWorkspaceEvalJobs('p1', { suite: 'smoke', limit: 5 })).jobs[0]!.job_id).toBe('j1');
  });

  test('start, rerun, cancel and delete send their bodies', async () => {
    routes['POST /workspaces/p1/evals/jobs'] = { status: 201, body: { job: JOB } };
    routes['POST /workspaces/p1/evals/jobs/j1/rerun'] = { status: 201, body: { job: { ...JOB, job_id: 'j2', rerun_of: 'j1' } } };
    routes['POST /workspaces/p1/evals/jobs/j1/cancel'] = { status: 200, body: { job: { ...JOB, status: 'cancelled' } } };
    routes['DELETE /workspaces/p1/evals/jobs/j1'] = { status: 200, body: { ok: true } };
    await startWorkspaceEvalJob('p1', { suite: 'smoke', config: { n_attempts: 3 } });
    expect((await rerunWorkspaceEvalJob('p1', 'j1', { scope: 'failed' })).rerun_of).toBe('j1');
    expect((await cancelWorkspaceEvalJob('p1', 'j1')).status).toBe('cancelled');
    await deleteWorkspaceEvalJob('p1', 'j1');
    expect(calls.map((c) => [c.key, c.body])).toEqual([
      ['POST /workspaces/p1/evals/jobs', { suite: 'smoke', config: { n_attempts: 3 } }],
      ['POST /workspaces/p1/evals/jobs/j1/rerun', { scope: 'failed' }],
      ['POST /workspaces/p1/evals/jobs/j1/cancel', {}],
      ['DELETE /workspaces/p1/evals/jobs/j1', null],
    ]);
  });

  test('a job, its trials, one trial and one of its files', async () => {
    routes['GET /workspaces/p1/evals/jobs/j1'] = { status: 200, body: { job: JOB } };
    routes['GET /workspaces/p1/evals/jobs/j1/trials'] = { status: 200, body: { trials: [{ trial_id: 't1' }] } };
    routes['GET /workspaces/p1/evals/jobs/j1/trials/t1'] = { status: 200, body: { trial: { trial_id: 't1' }, instruction: 'Do it', files: [] } };
    routes['GET /workspaces/p1/evals/jobs/j1/trials/t1/file?path=verifier%2Ftest-stdout.txt'] = { status: 200, body: 'ok 3/3\n' };
    expect((await getWorkspaceEvalJob('p1', 'j1')).job_name).toBe('smoke-1');
    expect((await listWorkspaceEvalTrials('p1', 'j1'))[0]!.trial_id).toBe('t1');
    expect((await getWorkspaceEvalTrial('p1', 'j1', 't1')).instruction).toBe('Do it');
    expect(await readWorkspaceEvalTrialFile('p1', 'j1', 't1', 'verifier/test-stdout.txt')).toBe('ok 3/3\n');
  });

  test('tasks of a dataset by name, one task, one of its files, and its results across jobs', async () => {
    routes['GET /workspaces/p1/evals/tasks?dataset=terminal-bench&version=2.0'] = { status: 200, body: { commit: 'abc', tasks: [{ task_id: 'T1', name: 'fix-git' }], readme: '# TB' } };
    routes['GET /workspaces/p1/evals/tasks/T1'] = { status: 200, body: { task: { task_id: 'T1', name: 'fix-git' }, readme: null, task_toml: '[agent]', files: [{ path: 'tests/test.sh', size: null }] } };
    routes['GET /workspaces/p1/evals/tasks/T1/file?path=tests%2Ftest.sh'] = { status: 200, body: '#!/bin/bash\n' };
    routes['GET /workspaces/p1/evals/tasks/T1/results'] = { status: 200, body: { results: [{ job_id: 'j1', trial_id: 't1' }], summary: [{ agent: 'worker', model: null, n: 1, n_passed: 1, mean_reward: 1 }] } };
    const listed = await listWorkspaceEvalTasks('p1', { dataset: 'terminal-bench', version: '2.0' });
    expect([listed.readme, listed.tasks[0]!.task_id]).toEqual(['# TB', 'T1']);
    expect((await getWorkspaceEvalTask('p1', 'T1')).files[0]!.path).toBe('tests/test.sh');
    expect(await readWorkspaceEvalTaskFile('p1', 'T1', 'tests/test.sh')).toBe('#!/bin/bash\n');
    const results = await listWorkspaceEvalTaskResults('p1', 'T1');
    expect([results.results[0]!.trial_id, results.summary[0]!.n_passed]).toEqual(['t1', 1]);
  });

  test('a job list sends its filters; the datasets carry the registry error', async () => {
    routes['GET /workspaces/p1/evals/jobs?status=running&dataset=kortix%2Fmy-kortix&agent=worker&q=nightly&limit=20'] = { status: 200, body: { jobs: [JOB], next_cursor: 'c2', total: 41 } };
    routes['GET /workspaces/p1/evals/datasets'] = { status: 200, body: { datasets: [{ name: 'kortix/my-kortix', kind: 'builtin' }], registry_error: 'timeout' } };
    const page = await listWorkspaceEvalJobs('p1', { status: 'running', dataset: 'kortix/my-kortix', agent: 'worker', q: 'nightly', limit: 20 });
    expect([page.total, page.next_cursor]).toEqual([41, 'c2']);
    const catalog = await listWorkspaceEvalDatasets('p1');
    expect([catalog.datasets[0]!.kind, catalog.registry_error]).toEqual(['builtin', 'timeout']);
  });

  test('a start and a rerun carry the idempotency key; a plan sends dry_run and no key', async () => {
    routes['POST /workspaces/p1/evals/jobs'] = { status: 201, body: { job: JOB } };
    routes['POST /workspaces/p1/evals/jobs/j1/rerun'] = { status: 201, body: { job: JOB } };
    await startWorkspaceEvalJob('p1', { suite: 'smoke' }, { idempotencyKey: 'k-1' });
    await rerunWorkspaceEvalJob('p1', 'j1', { scope: 'errored' }, { idempotencyKey: 'k-2' });
    routes['POST /workspaces/p1/evals/jobs'] = { status: 200, body: { commit: 'abc', n_tasks: 5, n_trials: 10, agents: [], tasks: [], warnings: [] } };
    expect((await planWorkspaceEvalJob('p1', { suite: 'smoke' })).n_trials).toBe(10);
    expect(calls.map((c) => [c.key, c.body, c.idempotencyKey])).toEqual([
      ['POST /workspaces/p1/evals/jobs', { suite: 'smoke' }, 'k-1'],
      ['POST /workspaces/p1/evals/jobs/j1/rerun', { scope: 'errored' }, 'k-2'],
      ['POST /workspaces/p1/evals/jobs', { suite: 'smoke', dry_run: true }, null],
    ]);
  });

  test('compare names its jobs in order; one trial retries and cancels in its job', async () => {
    routes['GET /workspaces/p1/evals/compare?jobs=j1%2Cj2&by=task_agent_model'] = { status: 200, body: { jobs: [], by: 'task_agent_model', rows: [], summary: { better: 2, worse: 1, same: 7, only_one: 0 } } };
    routes['POST /workspaces/p1/evals/jobs/j1/trials/t1/retry'] = { status: 201, body: { trial: { trial_id: 't9', retry: 1 } } };
    routes['POST /workspaces/p1/evals/jobs/j1/trials/t2/cancel'] = { status: 200, body: { trial: { trial_id: 't2', status: 'cancelled' } } };
    expect((await compareWorkspaceEvalJobs('p1', ['j1', 'j2'], { by: 'task_agent_model' })).summary.worse).toBe(1);
    expect((await retryWorkspaceEvalTrial('p1', 'j1', 't1')).retry).toBe(1);
    expect((await cancelWorkspaceEvalTrial('p1', 'j1', 't2')).status).toBe('cancelled');
  });

  test('a .json trial file reads back as written, even when it does not parse', async () => {
    routes['GET /workspaces/p1/evals/jobs/j1/trials/t1/file?path=verifier%2Freward.json'] = { status: 200, body: '{"reward": 1,' };
    expect(await readWorkspaceEvalTrialFile('p1', 'j1', 't1', 'verifier/reward.json')).toBe('{"reward": 1,');
  });

  test('an eval_invalid answer throws ApiError with the violations', async () => {
    routes['POST /workspaces/p1/evals/jobs'] = { status: 422, body: { error: 'eval_invalid', message: 'evals/x: no task found', violations: ['evals/x: no task found'] } };
    const err = await startWorkspaceEvalJob('p1', { suite: 'smoke' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toContain('no task found');
  });

  test('an id with a "." or ".." segment is refused before any request', async () => {
    await expect(getWorkspaceEvalJob('p1', '..')).rejects.toThrow('another endpoint');
    expect(calls).toEqual([]);
  });
});

describe('scores', () => {
  const trial = (rewards: Record<string, number> | null, valid = true) => ({ rewards, reward_valid: valid }) as WorkspaceEvalTrial;
  test('a trial passes when every reward is 1 or more; its score is the mean of its rewards', () => {
    expect(evalTrialScore(trial({ reward: 1 }))).toEqual({ passed: true, score: 1 });
    expect(evalTrialScore(trial({ exists: 1, correctness: 0.5 }))).toEqual({ passed: false, score: 0.75 });
    expect(evalTrialScore(trial(null))).toEqual({ passed: false, score: null });
    expect(evalTrialScore(trial({ reward: 1 }, false))).toEqual({ passed: false, score: null });
  });
  test('the headline of a job is pass@1 of its best agent, with its metric', () => {
    expect(evalJobScore(JOB)).toEqual({ agent: 'worker', model: 'p/m', passAt1: 0.5, metric: { name: 'mean', value: 0.6667 }, mean: 0.6667, validTrials: 3, errors: 1 });
    expect(evalJobScore({ ...JOB, stats: { ...STATS, agents: [] } })).toBeNull();
  });
  test('with several graded keys the headline is the mean over the keys', () => {
    const stats = { agent: 'a', model: null, source: null, n_trials: 2, n_errors: 0, metrics: [{ exists: 1, correctness: 0.5 }], pass_at_k: {} };
    const job = { ...JOB, stats: { ...STATS, agents: [stats] } } as unknown as WorkspaceEvalJob;
    expect(evalJobScore(job)).toMatchObject({ passAt1: null, metric: null, mean: 0.75 });
  });
  test('with graded rewards (no pass@k) the best agent is the one with the highest metric', () => {
    const graded = (agent: string, mean: number) => ({ agent, model: null, source: null, n_trials: 2, n_errors: 0, metrics: [{ mean }], pass_at_k: {} });
    const job = { ...JOB, stats: { ...STATS, agents: [graded('a', 0.4), graded('b', 0.9)] } } as unknown as WorkspaceEvalJob;
    expect(evalJobScore(job)).toMatchObject({ agent: 'b', passAt1: null, metric: { name: 'mean', value: 0.9 } });
  });
});
