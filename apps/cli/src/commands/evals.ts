/**
 * `kortix evals`: run agents on a list of tasks and score them (project flag `evals`).
 *
 * The Evals API is the authority (`/v1/workspaces/:id/evals/*`, wire contract
 * `packages/api-contract/src/evals.ts`), reached through `@kortix/sdk`. A task
 * is in the Harbor format: `instruction.md`, `task.toml`, `environment/`,
 * `tests/test.sh` (writes the reward), and an optional `solution/solve.sh`. A
 * suite is a job config under `evals:` in kortix.yaml, or `config:` to a
 * Harbor job config file. `kortix evals init` writes a first task and suite.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cancelWorkspaceEvalJob,
  cancelWorkspaceEvalTrial,
  compareWorkspaceEvalJobs,
  deleteWorkspaceEvalJob,
  evalJobScore,
  evalTrialScore,
  getWorkspaceEvalJob,
  getWorkspaceEvalTrial,
  listWorkspaceEvalDatasets,
  listWorkspaceEvalJobs,
  listWorkspaceEvalSuites,
  listWorkspaceEvalTasks,
  listWorkspaceEvalTrials,
  readWorkspaceEvalTrialFile,
  rerunWorkspaceEvalJob,
  retryWorkspaceEvalTrial,
  startWorkspaceEvalJob,
} from '@kortix/sdk';
import type { WorkspaceEvalJob, WorkspaceEvalJobConfig, WorkspaceEvalJobFilters, WorkspaceEvalJobStatus, WorkspaceEvalTrial } from '@kortix/sdk';
import type { Auth } from '../api/auth.ts';
import { withCliErrors } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';
import { C, help, pad } from '../style.ts';

const HELP = help`Usage: kortix evals <subcommand> [options]

Run agents on a list of tasks and score them. A task is a folder in the Harbor
format: instruction.md (the prompt), task.toml (timeouts, resources),
environment/ (the sandbox), tests/test.sh (writes the reward to
/logs/verifier/reward.txt or reward.json) and an optional solution/solve.sh.
A suite is a job config under \`evals:\` in kortix.yaml. Each trial runs in its
own session and sandbox; the tests reach the sandbox only after the agent stops.

Subcommands:
  init [<dir>]          Write a first task (evals/tasks/hello-world) and print
                        the \`evals:\` section to add to kortix.yaml.
  suites                The suites of kortix.yaml, each with its last score.
  tasks <suite> | --path <dir> | --dataset <name>[@<version>]
                        The tasks a suite selects, parsed. Lists what Kortix
                        cannot run, and why.
  datasets              Datasets a job can name: built-in (kortix/my-kortix)
                        and the Harbor registry (terminal-bench, …).
  run <suite> [--agent <name>[@<provider/model>]]... [--attempts <n>]
        [--concurrency <n>] [--task <glob>]... [--ref <branch|sha>] [--wait]
                        Start a job. Flags override the suite's fields.
                        --wait prints progress until the job ends and exits
                        non-zero when a trial errored.
  run --path <dir> --agent <name> ...
                        Start a job on the tasks under a repository path,
                        without a suite.
  run --dataset <name>[@<version>] --agent <name> ...
                        Start a job on a dataset by name: a built-in one
                        (kortix/my-kortix) or one of the Harbor registry
                        (terminal-bench@2.0).
  jobs [<suite>] [--status <s>] [--dataset <name>] [--agent <name>]
        [--model <id>] [-q <text>]
                        Jobs, newest first, with their scores. Filters narrow
                        the list; the count of every match is printed.
  show <job_id>         One job: score per agent and model, then every trial.
  watch <job_id>        Print trial progress until the job ends.
  trial <job_id> <trial_id> [--file <path>]
                        One trial: reward, error, timings, the instruction and
                        its files. --file prints one file (verifier/test-stdout.txt).
  trial retry <job_id> <trial_id>
                        Run one ended trial again inside its job; the new run
                        replaces it in every score.
  trial cancel <job_id> <trial_id>
                        Stop one queued or running trial; the job runs on.
  compare <job_a> <job_b> [<job_c>...] [--by task|task_agent_model]
                        Task by task: the pass rate in each job, and the change
                        from the first job to the last.
  rerun <job_id> [--failed | --errored]
                        A new job with the trials of this one (all, the failed
                        ones, or the errored ones), at the same commit.
  cancel <job_id>       Stop a job: no trial starts, running sandboxes stop.
  rm <job_id>           Delete an ended job and its folder in Files.

In a verifier (tests/test.sh), for open-ended tasks:
  judge --criterion <name>="<what earns 1.0>"... [--input <file>]...
        [--rubric <file>] [--model <id>] [--out <reward.json>]
                        A model scores the inputs on each criterion from 0 to 1
                        through the Kortix LLM gateway, as this session. The
                        scores merge into --out (default
                        /logs/verifier/reward.json), so code checks and judge
                        scores combine in one reward. The reasoning goes to
                        stdout (the trial's verifier/test-stdout.txt). Exit 0
                        when every criterion scored, 1 otherwise.

Agents: an agent of kortix.yaml, \`oracle\` (runs solution/solve.sh; proves a task
is solvable and its verifier passes it) or \`nop\` (does nothing; a task that
passes with nop is broken).

Options:
  --json                Machine-readable output.
  -h, --help            Show this help.
`;

const SUBCOMMANDS = ['judge', 'init', 'suites', 'tasks', 'datasets', 'run', 'jobs', 'ls', 'show', 'watch', 'trial', 'compare', 'rerun', 'cancel', 'rm'];

interface Ctx {
  auth: Auth;
  projectId: string;
  json: boolean;
}

const sdk = <T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> => withCliErrors(ctx.auth, fn);

const percent = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`);
const short = (id: string): string => id.slice(0, 8);

function statusColor(status: string): string {
  if (status === 'completed') return C.green;
  if (status === 'errored' || status === 'cancelled') return C.red;
  return C.cyan;
}

function scoreLine(job: WorkspaceEvalJob): string {
  const score = evalJobScore(job);
  if (!score) return '—';
  const metric = score.metric ? `  ${score.metric.name} ${score.metric.value.toFixed(3)}` : '';
  return `pass@1 ${percent(score.passAt1)}${metric}`;
}

function progressLine(job: WorkspaceEvalJob): string {
  const s = job.stats;
  return `${s.n_completed + s.n_errored + s.n_cancelled}/${s.n_total_trials} done · ${s.n_running} running · ${s.n_queued} queued · ${s.n_errored} errored`;
}

// ── init ─────────────────────────────────────────────────────────────────────

const INIT_FILES: Record<string, string> = {
  'task.toml': `schema_version = "1.4"

[metadata]
difficulty = "easy"
category = "files"

[agent]
timeout_sec = 300.0

[verifier]
timeout_sec = 60.0
environment_mode = "shared"
`,
  'instruction.md': 'Create the file `/var/tmp/hello.txt`. Its content must be exactly `Hello, world!` followed by one newline.\n',
  'solution/solve.sh': '#!/bin/bash\nset -euo pipefail\necho "Hello, world!" > /var/tmp/hello.txt\n',
  'tests/test.sh': `#!/bin/bash
# The verifier: runs after the agent stops and writes the reward.
mkdir -p /logs/verifier
if [ "$(cat /var/tmp/hello.txt 2>/dev/null)" = "Hello, world!" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
`,
};

function initTask(dir: string | undefined, json: boolean): number {
  const root = join(dir ?? 'evals/tasks', 'hello-world');
  const written: string[] = [];
  for (const [path, content] of Object.entries(INIT_FILES)) {
    const target = join(root, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: path.endsWith('.sh') ? 0o755 : 0o644 });
    written.push(target);
  }
  const tasksDir = dir ?? 'evals/tasks';
  const section = `evals:\n  smoke:\n    tasks: ${tasksDir}\n    agents: [oracle, nop]   # oracle must score 1, nop must score 0\n  default:\n    tasks: ${tasksDir}\n    agents: [default]\n    n_attempts: 3\n`;
  const manifest = existsSync('kortix.yaml') ? readFileSync('kortix.yaml', 'utf8') : '';
  if (json) {
    emitJson({ written, evals_section: section, manifest_has_evals: /^evals:/m.test(manifest) });
    return 0;
  }
  for (const path of written) process.stdout.write(`  ${C.green}+${C.reset} ${path}\n`);
  if (!written.length) process.stdout.write(`  ${C.dim}${root} exists; nothing written.${C.reset}\n`);
  process.stdout.write(`\n  ${/^evals:/m.test(manifest) ? 'kortix.yaml has an `evals:` section. A suite for this task:' : 'Add to kortix.yaml:'}\n\n${section.replace(/^/gm, '    ')}\n`);
  process.stdout.write(`  Then commit and run: ${C.bold}kortix evals run smoke --wait${C.reset}\n`);
  return 0;
}

// ── read commands ────────────────────────────────────────────────────────────

async function listSuites(ctx: Ctx): Promise<number> {
  const suites = await sdk(ctx, () => listWorkspaceEvalSuites(ctx.projectId));
  if (ctx.json) return (emitJson({ suites }), 0);
  if (!suites.length) {
    process.stdout.write(`  ${C.dim}kortix.yaml declares no \`evals:\` suite. Run \`kortix evals init\`.${C.reset}\n`);
    return 0;
  }
  const w = Math.max(5, ...suites.map((s) => s.name.length));
  process.stdout.write(`\n  ${C.dim}${pad('SUITE', w)}  ${pad('AGENTS', 28)}  ${pad('LAST JOB', 30)}  SCORE${C.reset}\n`);
  for (const suite of suites) {
    const agents = suite.config ? suite.config.agents.map((a) => (a.model_name ? `${a.name}@${a.model_name}` : a.name)).join(', ') : '';
    const last = suite.last_job ? `${suite.last_job.job_name.slice(0, 30)}` : '—';
    process.stdout.write(`  ${pad(suite.name, w)}  ${pad(agents.slice(0, 28), 28)}  ${pad(last, 30)}  ${suite.last_job ? scoreLine(suite.last_job) : '—'}\n`);
    if (suite.error) process.stdout.write(`  ${' '.repeat(w)}  ${C.red}${suite.error}${C.reset}\n`);
    for (const warning of suite.warnings) process.stdout.write(`  ${' '.repeat(w)}  ${C.dim}${warning}${C.reset}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

/** `name` or `name@version`; a name holds no `@` (Harbor and built-in names do not). */
function splitDataset(value: string | undefined): { name: string; version: string | null } | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  return at > 0 ? { name: value.slice(0, at), version: value.slice(at + 1) || null } : { name: value, version: null };
}

async function listTasks(ctx: Ctx, suite: string | undefined, path: string | undefined, ref: string | undefined, datasetFlag?: string): Promise<number> {
  const dataset = splitDataset(datasetFlag);
  if (!suite && !path && !dataset) return fail('Name a suite, or pass --path <dir> or --dataset <name>. Run `kortix evals suites`.');
  const result = await sdk(ctx, () => listWorkspaceEvalTasks(ctx.projectId, { suite, path, ref, ...(dataset ? { dataset: dataset.name, version: dataset.version } : {}) }));
  if (ctx.json) return (emitJson(result), 0);
  const w = Math.max(4, ...result.tasks.map((t) => t.name.length));
  process.stdout.write(`\n  ${C.dim}${result.tasks.length} task(s) at ${result.commit?.slice(0, 7) ?? '?'}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}${pad('TASK', w)}  ${pad('AGENT/VERIFIER S', 16)}  ${pad('SOLUTION', 8)}  ENVIRONMENT${C.reset}\n`);
  for (const task of result.tasks) {
    process.stdout.write(`  ${pad(task.name, w)}  ${pad(`${task.agent_timeout_sec}/${task.verifier_timeout_sec}`, 16)}  ${pad(task.has_solution ? 'yes' : 'no', 8)}  ${task.environment ?? 'the agent\'s sandbox'}\n`);
    if (task.unsupported) process.stdout.write(`  ${' '.repeat(w)}  ${C.red}cannot run: ${task.unsupported}${C.reset}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function listDatasets(ctx: Ctx): Promise<number> {
  const catalog = await sdk(ctx, () => listWorkspaceEvalDatasets(ctx.projectId));
  if (ctx.json) return (emitJson(catalog), 0);
  const { datasets } = catalog;
  const w = Math.max(7, ...datasets.map((d) => `${d.name}@${d.version}`.length));
  process.stdout.write(`\n  ${C.dim}${pad('DATASET', w)}  ${pad('KIND', 8)}  ${pad('TASKS', 6)}  DESCRIPTION${C.reset}\n`);
  for (const d of datasets) process.stdout.write(`  ${pad(`${d.name}@${d.version}`, w)}  ${pad(d.kind, 8)}  ${pad(d.n_tasks === null ? '—' : String(d.n_tasks), 6)}  ${d.description.slice(0, 80)}\n`);
  if (catalog.registry_error) process.stdout.write(`\n  ${C.red}The Harbor registry is not listed: ${catalog.registry_error}${C.reset}\n`);
  process.stdout.write(`\n  ${C.dim}Use one in a suite: datasets: [{ name: terminal-bench, version: "2.0", n_tasks: 5 }]${C.reset}\n\n`);
  return 0;
}

async function listJobs(ctx: Ctx, filters: WorkspaceEvalJobFilters): Promise<number> {
  const { jobs, total } = await sdk(ctx, () => listWorkspaceEvalJobs(ctx.projectId, { ...filters, limit: 50 }));
  if (ctx.json) return (emitJson({ jobs, total }), 0);
  if (!jobs.length) {
    const filtered = Object.values(filters).some(Boolean);
    process.stdout.write(`  ${C.dim}${filtered ? 'No job matches.' : 'No jobs yet. Start one: kortix evals run <suite>'}${C.reset}\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.dim}${pad('JOB', 8)}  ${pad('NAME', 40)}  ${pad('STATUS', 10)}  ${pad('TRIALS', 7)}  ${pad('COMMIT', 7)}  SCORE${C.reset}\n`);
  for (const job of jobs) {
    process.stdout.write(`  ${short(job.job_id)}  ${pad(job.job_name.slice(0, 40), 40)}  ${statusColor(job.status)}${pad(job.status, 10)}${C.reset}  ${pad(String(job.stats.n_total_trials), 7)}  ${pad(job.commit?.slice(0, 7) ?? '—', 7)}  ${scoreLine(job)}\n`);
  }
  process.stdout.write(`\n  ${C.dim}${jobs.length} of ${total} job(s)${C.reset}\n\n`);
  return 0;
}

const JOB_STATUSES: readonly WorkspaceEvalJobStatus[] = ['queued', 'running', 'completed', 'cancelled'];

function jobFilterFlags(rest: string[]): WorkspaceEvalJobFilters | string {
  const status = takeFlagValue(rest, ['--status']);
  if (status && !(JOB_STATUSES as readonly string[]).includes(status)) return `--status is one of ${JOB_STATUSES.join(', ')}.`;
  return {
    status: status as WorkspaceEvalJobStatus | undefined,
    dataset: takeFlagValue(rest, ['--dataset', '-d']),
    agent: takeFlagValue(rest, ['--agent']),
    model: takeFlagValue(rest, ['--model']),
    q: takeFlagValue(rest, ['-q', '--query']),
    suite: rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined,
  };
}

/** A job id, or a prefix of one of the 50 newest jobs. */
async function resolveJobId(ctx: Ctx, id: string | undefined): Promise<string> {
  if (!id) throw new Error('Name a job: its id or the first 8 characters of it (kortix evals jobs).');
  if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  const { jobs } = await sdk(ctx, () => listWorkspaceEvalJobs(ctx.projectId, { limit: 50 }));
  const matches = jobs.filter((job) => job.job_id.startsWith(id) || job.job_name === id);
  if (matches.length === 1) return matches[0]!.job_id;
  throw new Error(matches.length ? `"${id}" matches ${matches.length} jobs. Use more characters.` : `No job "${id}" among the 50 newest jobs.`);
}

function trialCell(trial: WorkspaceEvalTrial): string {
  const { passed, score } = evalTrialScore(trial);
  if (trial.exception) return `${C.red}${trial.exception.exception_type}${C.reset}${score !== null ? ` (score ${score.toFixed(2)})` : ''}`;
  if (score === null) return `${C.dim}${trial.status}${C.reset}`;
  return `${passed ? C.green : C.red}${passed ? 'pass' : 'fail'}${C.reset} ${JSON.stringify(trial.rewards)}`;
}

async function showJob(ctx: Ctx, id: string | undefined): Promise<number> {
  const jobId = await resolveJobId(ctx, id);
  const [job, trials] = await Promise.all([sdk(ctx, () => getWorkspaceEvalJob(ctx.projectId, jobId)), sdk(ctx, () => listWorkspaceEvalTrials(ctx.projectId, jobId))]);
  if (ctx.json) return (emitJson({ job, trials }), 0);
  process.stdout.write(`\n  ${C.bold}${job.job_name}${C.reset}  ${statusColor(job.status)}${job.status}${C.reset}  ${C.dim}${job.job_id} · commit ${job.commit?.slice(0, 7) ?? '—'}${job.rerun_of ? ` · rerun of ${short(job.rerun_of)}` : ''}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}${progressLine(job)} · results in Files ${job.folder}${C.reset}\n\n`);
  process.stdout.write(`  ${C.dim}${pad('AGENT', 36)}  ${pad('PASS@1', 7)}  ${pad('PASS@K', 18)}  ${pad('VALID', 5)}  ${pad('ERRORS', 6)}  METRICS${C.reset}\n`);
  for (const agent of job.stats.agents) {
    const passK = Object.entries(agent.pass_at_k).map(([k, v]) => `@${k} ${percent(v)}`).join(' ');
    const metrics = agent.metrics.map((m) => Object.entries(m).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')).join(' | ');
    process.stdout.write(`  ${pad(`${agent.agent}${agent.model ? ` @ ${agent.model}` : ''}`.slice(0, 36), 36)}  ${pad(percent(agent.pass_at_k['1']), 7)}  ${pad(passK.slice(0, 18), 18)}  ${pad(String(agent.n_trials), 5)}  ${pad(String(agent.n_errors), 6)}  ${metrics}\n`);
  }
  const w = Math.max(5, ...trials.map((t) => t.trial_name.length));
  process.stdout.write(`\n  ${C.dim}${pad('TRIAL', w)}  ${pad('ID', 8)}  RESULT${C.reset}\n`);
  for (const trial of trials) process.stdout.write(`  ${pad(trial.trial_name, w)}  ${short(trial.trial_id)}  ${trialCell(trial)}\n`);
  process.stdout.write('\n');
  return 0;
}

/** A trial id, or a prefix or name of a trial of the job. */
async function resolveTrialId(ctx: Ctx, jobId: string, trialArg: string | undefined): Promise<string> {
  if (!trialArg) throw new Error('Name a trial: its id, the first 8 characters of it, or its name (kortix evals show <job_id>).');
  if (/^[0-9a-f-]{36}$/i.test(trialArg)) return trialArg;
  const trials = await sdk(ctx, () => listWorkspaceEvalTrials(ctx.projectId, jobId));
  const match = trials.filter((t) => t.trial_id.startsWith(trialArg) || t.trial_name === trialArg);
  if (match.length !== 1) throw new Error(`"${trialArg}" matches ${match.length} trials of this job.`);
  return match[0]!.trial_id;
}

async function trialAction(ctx: Ctx, action: 'retry' | 'cancel', jobArg: string | undefined, trialArg: string | undefined): Promise<number> {
  const jobId = await resolveJobId(ctx, jobArg);
  const trialId = await resolveTrialId(ctx, jobId, trialArg);
  const trial = await sdk(ctx, () => (action === 'retry' ? retryWorkspaceEvalTrial(ctx.projectId, jobId, trialId) : cancelWorkspaceEvalTrial(ctx.projectId, jobId, trialId)));
  if (ctx.json) return (emitJson({ trial }), 0);
  process.stdout.write(
    action === 'retry'
      ? `  Queued ${C.bold}${trial.trial_name}${C.reset} (retry ${trial.retry}) in job ${short(jobId)}. Follow it: kortix evals watch ${short(jobId)}\n`
      : `  ${trial.trial_name}: ${trial.status}\n`,
  );
  return 0;
}

async function showTrial(ctx: Ctx, jobArg: string | undefined, trialArg: string | undefined, file: string | undefined): Promise<number> {
  const jobId = await resolveJobId(ctx, jobArg);
  const trialId = await resolveTrialId(ctx, jobId, trialArg);
  if (file) {
    process.stdout.write(await sdk(ctx, () => readWorkspaceEvalTrialFile(ctx.projectId, jobId, trialId, file)));
    return 0;
  }
  const detail = await sdk(ctx, () => getWorkspaceEvalTrial(ctx.projectId, jobId, trialId));
  if (ctx.json) return (emitJson(detail), 0);
  const t = detail.trial;
  process.stdout.write(`\n  ${C.bold}${t.trial_name}${C.reset}  ${statusColor(t.status)}${t.status}${C.reset}  ${trialCell(t)}\n`);
  process.stdout.write(`  ${C.dim}task ${t.task_path} · agent ${t.agent}${t.model ? ` @ ${t.model}` : ''} · attempt ${t.attempt}${t.retry ? ` retry ${t.retry}` : ''} · session ${t.session_id ?? '—'}${C.reset}\n`);
  if (t.exception) process.stdout.write(`  ${C.red}${t.exception.exception_type}: ${t.exception.exception_message}${C.reset}\n  ${C.dim}policy: retry ${t.exception.policy.should_retry}, graded ${t.exception.policy.should_grade}, reward counts ${t.exception.policy.has_valid_reward}${C.reset}\n`);
  const secs = (timing: { started_at: string | null; finished_at: string | null }) =>
    timing.started_at && timing.finished_at ? `${Math.round((Date.parse(timing.finished_at) - Date.parse(timing.started_at)) / 100) / 10} s` : '—';
  const cost = t.usage?.cost_usd != null ? ` · $${t.usage.cost_usd.toFixed(4)}` : '';
  process.stdout.write(`  ${C.dim}sandbox ${secs(t.environment_setup)} · agent ${secs(t.agent_execution)} · verifier ${secs(t.verifier)}${t.usage ? ` · tokens in ${t.usage.n_input_tokens} out ${t.usage.n_output_tokens}${cost}` : ''}${C.reset}\n`);
  if (detail.instruction) process.stdout.write(`\n  ${C.dim}Instruction:${C.reset}\n${detail.instruction.replace(/^/gm, '    ')}\n`);
  if (detail.files.length) {
    process.stdout.write(`\n  ${C.dim}Files (kortix evals trial ${short(jobId)} ${short(t.trial_id)} --file <path>):${C.reset}\n`);
    for (const f of detail.files) process.stdout.write(`    ${f.path}  ${C.dim}${f.size} B${C.reset}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

// ── compare ──────────────────────────────────────────────────────────────────

/** The API compares (`GET /evals/compare`): one row per task (per task × agent × model when a job ran several), first job against last. */
async function compareJobs(ctx: Ctx, args: string[], by: string | undefined): Promise<number> {
  if (args.length < 2) return fail('Name two or more jobs: kortix evals compare <job_a> <job_b> [<job_c>...].');
  if (by && by !== 'task' && by !== 'task_agent_model') return fail('--by is task or task_agent_model.');
  const ids: string[] = [];
  for (const arg of args) ids.push(await resolveJobId(ctx, arg));
  const result = await sdk(ctx, () => compareWorkspaceEvalJobs(ctx.projectId, ids, by ? { by: by as 'task' | 'task_agent_model' } : undefined));
  if (ctx.json) return (emitJson(result), 0);
  const letter = (i: number) => String.fromCharCode(65 + i);
  process.stdout.write('\n');
  result.jobs.forEach((job, i) => process.stdout.write(`  ${letter(i)} ${C.bold}${job.job_name}${C.reset} ${C.dim}(${job.commit?.slice(0, 7) ?? '—'})${C.reset}  ${scoreLine(job)}\n`));
  const label = (row: (typeof result.rows)[number]) => (row.agent ? `${row.task_name} · ${row.agent}${row.model ? ` @ ${row.model}` : ''}` : row.task_name);
  const w = Math.max(4, ...result.rows.map((row) => label(row).length));
  process.stdout.write(`\n  ${C.dim}${pad('TASK', w)}  ${result.jobs.map((_, i) => pad(letter(i), 7)).join('  ')}  CHANGE${C.reset}\n`);
  for (const row of result.rows) {
    const color = row.change === 'better' ? C.green : row.change === 'worse' ? C.red : C.dim;
    const cells = row.cells.map((cell) => pad(cell.pass_rate === null ? (cell.exception_type ? 'error' : '—') : percent(cell.pass_rate), 7)).join('  ');
    process.stdout.write(`  ${pad(label(row), w)}  ${cells}  ${color}${row.change === 'only_one' ? 'only in one' : row.change}${C.reset}\n`);
  }
  const { better, worse, same, only_one } = result.summary;
  process.stdout.write(`\n  ${C.green}${better} better${C.reset} · ${C.red}${worse} worse${C.reset} · ${same} same${only_one ? ` · ${only_one} only in one` : ''}\n\n`);
  return 0;
}

// ── writes ───────────────────────────────────────────────────────────────────

/** `--agent name` or `--agent name@provider/model`. */
function agentFlags(values: string[]): WorkspaceEvalJobConfig['agents'] | undefined {
  if (!values.length) return undefined;
  return values.map((value) => {
    const at = value.indexOf('@');
    return at > 0 ? { name: value.slice(0, at), model_name: value.slice(at + 1) } : { name: value };
  });
}

const TERMINAL = new Set(['completed', 'cancelled']);

async function watchJob(ctx: Ctx, jobId: string, opts: { quiet?: boolean } = {}): Promise<number> {
  let last = '';
  for (;;) {
    const job = await sdk(ctx, () => getWorkspaceEvalJob(ctx.projectId, jobId));
    const line = progressLine(job);
    if (line !== last && !ctx.json && !opts.quiet) {
      process.stdout.write(`  ${C.dim}${new Date().toISOString().slice(11, 19)}${C.reset}  ${line}\n`);
      last = line;
    }
    if (TERMINAL.has(job.status)) {
      if (ctx.json) emitJson({ job });
      else process.stdout.write(`\n  ${statusColor(job.status)}${job.status}${C.reset}  ${scoreLine(job)}  ${C.dim}kortix evals show ${short(job.job_id)}${C.reset}\n\n`);
      return job.status === 'completed' && job.stats.n_errored === 0 ? 0 : 1;
    }
    await Bun.sleep(5_000);
  }
}

async function runJob(ctx: Ctx, suite: string | undefined, argv: string[]): Promise<number> {
  const path = takeFlagValue(argv, ['--path']);
  const dataset = splitDataset(takeFlagValue(argv, ['--dataset', '-d']));
  const agents = agentFlags(takeFlagValues(argv, ['--agent']));
  const attempts = takeFlagValue(argv, ['--attempts', '-k']);
  const concurrency = takeFlagValue(argv, ['--concurrency', '-n']);
  const tasks = takeFlagValues(argv, ['--task', '-i']);
  const ref = takeFlagValue(argv, ['--ref']);
  const name = takeFlagValue(argv, ['--name']);
  const wait = takeFlagBool(argv, ['--wait']);
  if (!suite && !path && !dataset) return fail('Name a suite, or pass --path <dir> or --dataset <name> with --agent. Run `kortix evals suites` or `kortix evals datasets`.');
  if (!suite && !agents) return fail(`${dataset ? '--dataset' : '--path'} needs --agent <name> (an agent of kortix.yaml, oracle or nop).`);
  const toInt = (value: string | undefined, flag: string): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer.`);
    return n;
  };
  const config: Partial<WorkspaceEvalJobConfig> = {
    ...(agents ? { agents } : {}),
    ...(attempts ? { n_attempts: toInt(attempts, '--attempts') } : {}),
    ...(concurrency ? { n_concurrent_trials: toInt(concurrency, '--concurrency') } : {}),
    ...(name ? { job_name: name } : {}),
    ...(path ? { tasks: [{ path, ...(tasks.length ? { task_names: tasks } : {}) }], datasets: [] } : {}),
    ...(dataset ? { tasks: [], datasets: [{ name: dataset.name, ...(dataset.version ? { version: dataset.version } : {}), ...(tasks.length ? { task_names: tasks } : {}) }] } : {}),
  };
  if (!path && !dataset && tasks.length) {
    // A task filter on a suite applies to each of its sources.
    const suites = await sdk(ctx, () => listWorkspaceEvalSuites(ctx.projectId, { ref }));
    const declared = suites.find((s) => s.name === suite)?.config;
    if (!declared) return fail(`kortix.yaml has no valid suite "${suite}".`);
    config.tasks = declared.tasks.map((source) => ({ ...source, task_names: tasks }));
    config.datasets = declared.datasets.map((source) => ({ ...source, task_names: tasks }));
  }
  const job = await sdk(ctx, () => startWorkspaceEvalJob(ctx.projectId, { ...(suite ? { suite } : {}), ...(Object.keys(config).length ? { config } : {}), ...(ref ? { ref } : {}) }));
  if (!wait) {
    if (ctx.json) return (emitJson({ job }), 0);
    process.stdout.write(`\n  Started ${C.bold}${job.job_name}${C.reset}: ${job.stats.n_total_trials} trial(s) at ${job.commit?.slice(0, 7)}  ${C.dim}${job.job_id}${C.reset}\n  Watch: kortix evals watch ${short(job.job_id)}\n\n`);
    return 0;
  }
  if (!ctx.json) process.stdout.write(`\n  Started ${C.bold}${job.job_name}${C.reset}: ${job.stats.n_total_trials} trial(s) at ${job.commit?.slice(0, 7)}\n`);
  return watchJob(ctx, job.job_id);
}

async function rerunJob(ctx: Ctx, id: string | undefined, argv: string[]): Promise<number> {
  const jobId = await resolveJobId(ctx, id);
  const scope = takeFlagBool(argv, ['--failed']) ? 'failed' : takeFlagBool(argv, ['--errored']) ? 'errored' : 'all';
  const wait = takeFlagBool(argv, ['--wait']);
  const job = await sdk(ctx, () => rerunWorkspaceEvalJob(ctx.projectId, jobId, { scope }));
  if (wait) return watchJob(ctx, job.job_id);
  if (ctx.json) return (emitJson({ job }), 0);
  process.stdout.write(`\n  Started ${C.bold}${job.job_name}${C.reset}: ${job.stats.n_total_trials} ${scope === 'all' ? '' : `${scope} `}trial(s) again  ${C.dim}${job.job_id}${C.reset}\n\n`);
  return 0;
}

// ── judge ────────────────────────────────────────────────────────────────────

/** Bytes of one input file the judge reads: the end of a long log is kept. */
const JUDGE_INPUT_BYTES = 60_000;
const JUDGE_ENV_FILE = '/dev/shm/kortix/agent-env.sh';

/** KORTIX_TOKEN and KORTIX_API_URL from the environment, else from the sandbox's env file (a verifier runs without the agent's env). */
function sessionCredentials(): { token: string; apiUrl: string } | null {
  let token = process.env.KORTIX_TOKEN ?? '';
  let apiUrl = process.env.KORTIX_API_URL ?? '';
  if ((!token || !apiUrl) && existsSync(JUDGE_ENV_FILE)) {
    for (const line of readFileSync(JUDGE_ENV_FILE, 'utf8').split('\n')) {
      const match = /^export\s+(KORTIX_TOKEN|KORTIX_API_URL)='(.*)'$/.exec(line.trim());
      if (!match) continue;
      const value = match[2]!.replace(/'\\''/g, "'");
      if (match[1] === 'KORTIX_TOKEN' && !token) token = value;
      if (match[1] === 'KORTIX_API_URL' && !apiUrl) apiUrl = value;
    }
  }
  return token && apiUrl ? { token, apiUrl } : null;
}

/** The judge's reply: one score per criterion, clamped to 0..1. Null when it is not that shape. */
export function parseJudgeReply(text: string, criteria: string[]): { scores: Record<string, number>; reasoning: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const raw = (typeof record.scores === 'object' && record.scores !== null ? record.scores : record) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const name of criteria) {
    const value = Number(raw[name]);
    if (!Number.isFinite(value)) return null;
    scores[name] = Math.min(1, Math.max(0, value));
  }
  return { scores, reasoning: typeof record.reasoning === 'string' ? record.reasoning : '' };
}

async function judge(argv: string[], json: boolean): Promise<number> {
  const criteria = new Map<string, string>();
  for (const value of takeFlagValues(argv, ['--criterion', '-c'])) {
    const eq = value.indexOf('=');
    if (eq < 1) return fail(`--criterion "${value}" must be <name>="<what earns 1.0>".`);
    const name = value.slice(0, eq).trim();
    if (!/^[a-z0-9_]+$/.test(name)) return fail(`Criterion name "${name}" must be lowercase letters, digits and _.`);
    criteria.set(name, value.slice(eq + 1).trim());
  }
  const rubricPath = takeFlagValue(argv, ['--rubric']);
  const inputs = takeFlagValues(argv, ['--input', '-i']);
  const out = takeFlagValue(argv, ['--out']) ?? '/logs/verifier/reward.json';
  let model = takeFlagValue(argv, ['--model', '-m']) ?? process.env.KORTIX_EVAL_JUDGE_MODEL ?? '';
  if (!criteria.size) return fail('Pass at least one --criterion <name>="<what earns 1.0>".');
  const creds = sessionCredentials();
  if (!creds) return fail(`No session credentials: set KORTIX_TOKEN and KORTIX_API_URL, or run inside a Kortix sandbox (${JUDGE_ENV_FILE}).`);
  const gateway = `${new URL(creds.apiUrl).origin}/v1/llm/v1`;
  const headers = { Authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' };
  if (!model) {
    // The first model the gateway serves this session.
    const listed = (await fetch(`${gateway}/models`, { headers, signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => null)) as { data?: Array<{ id: string }> } | null;
    model = listed?.data?.[0]?.id ?? '';
    if (!model) return fail('No model: pass --model <id> or set KORTIX_EVAL_JUDGE_MODEL.');
  }
  const sections: string[] = [];
  if (rubricPath) sections.push(`## Rubric\n${readFileSync(rubricPath, 'utf8').slice(0, JUDGE_INPUT_BYTES)}`);
  for (const path of inputs) {
    if (!existsSync(path)) {
      sections.push(`## ${path}\n(missing: the file does not exist)`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    sections.push(`## ${path}\n${text.length > JUDGE_INPUT_BYTES ? `(last ${JUDGE_INPUT_BYTES} characters)\n${text.slice(-JUDGE_INPUT_BYTES)}` : text}`);
  }
  const names = [...criteria.keys()];
  const prompt = [
    'You grade the work of an AI agent. Score each criterion from 0 to 1: 1 fully met, 0 not met, a fraction for partial credit. Judge only from the material below; a missing file means the work is missing.',
    '',
    '## Criteria',
    ...[...criteria].map(([name, text]) => `- ${name}: ${text}`),
    '',
    ...sections,
    '',
    `Reply with one JSON object and nothing else: {"scores": {${names.map((n) => `"${n}": <0..1>`).join(', ')}}, "reasoning": "<one short paragraph>"}`,
  ].join('\n');
  let reply = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(`${gateway}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, temperature: 0, max_tokens: 4_000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(180_000),
    }).catch((err) => err as Error);
    if (res instanceof Error || !res.ok) {
      if (attempt === 3) return fail(`The judge model did not answer: ${res instanceof Error ? res.message : `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`}`);
      await Bun.sleep(2_000 * attempt);
      continue;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    reply = body.choices?.[0]?.message?.content ?? '';
    if (parseJudgeReply(reply, names)) break;
  }
  const result = parseJudgeReply(reply, names);
  if (!result) return fail(`The judge's reply is not one score per criterion: ${reply.slice(0, 300)}`);
  // Merge: a test.sh may have written code-checked rewards first.
  let merged: Record<string, number> = {};
  if (existsSync(out)) {
    try {
      merged = JSON.parse(readFileSync(out, 'utf8')) as Record<string, number>;
    } catch {
      merged = {};
    }
  }
  merged = { ...merged, ...result.scores };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(merged)}\n`);
  if (json) emitJson({ model, scores: result.scores, reasoning: result.reasoning, reward_file: out });
  else {
    process.stdout.write(`judge (${model}):\n`);
    for (const [name, value] of Object.entries(result.scores)) process.stdout.write(`  ${name} ${value}\n`);
    if (result.reasoning) process.stdout.write(`  ${result.reasoning}\n`);
  }
  return 0;
}

// ── entry ────────────────────────────────────────────────────────────────────

export async function runEvals(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  const json = takeFlagBool(rest, ['--json']);
  const sub = rest.shift();
  if (!sub || !SUBCOMMANDS.includes(sub)) return fail(`Unknown subcommand "${sub ?? ''}". Run \`kortix evals --help\`.`);
  if (sub === 'init') return initTask(rest[0], json);
  if (sub === 'judge') return judge(rest, json);
  const resolved = await resolveProjectContext({});
  if (!resolved) return 1;
  const ctx: Ctx = { auth: resolved.auth, projectId: resolved.projectId, json };
  try {
    switch (sub) {
      case 'suites':
        return await listSuites(ctx);
      case 'tasks': {
        const path = takeFlagValue(rest, ['--path']);
        const ref = takeFlagValue(rest, ['--ref']);
        const dataset = takeFlagValue(rest, ['--dataset', '-d']);
        return await listTasks(ctx, rest[0], path, ref, dataset);
      }
      case 'datasets':
        return await listDatasets(ctx);
      case 'run': {
        const suite = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
        return await runJob(ctx, suite, rest);
      }
      case 'jobs':
      case 'ls': {
        const filters = jobFilterFlags(rest);
        return typeof filters === 'string' ? fail(filters) : await listJobs(ctx, filters);
      }
      case 'show':
        return await showJob(ctx, rest[0]);
      case 'watch':
        return await watchJob(ctx, await resolveJobId(ctx, rest[0]));
      case 'trial': {
        if (rest[0] === 'retry' || rest[0] === 'cancel') return await trialAction(ctx, rest[0], rest[1], rest[2]);
        const file = takeFlagValue(rest, ['--file']);
        return await showTrial(ctx, rest[0], rest[1], file);
      }
      case 'compare': {
        const by = takeFlagValue(rest, ['--by']);
        return await compareJobs(ctx, rest.filter((arg) => !arg.startsWith('-')), by);
      }
      case 'rerun': {
        const id = rest.shift();
        return await rerunJob(ctx, id, rest);
      }
      case 'cancel': {
        const job = await sdk(ctx, async () => cancelWorkspaceEvalJob(ctx.projectId, await resolveJobId(ctx, rest[0])));
        if (ctx.json) return (emitJson({ job }), 0);
        process.stdout.write(`  ${job.job_name}: ${job.status} (${job.stats.n_cancelled} trial(s) cancelled)\n`);
        return 0;
      }
      case 'rm': {
        const jobId = await resolveJobId(ctx, rest[0]);
        await sdk(ctx, () => deleteWorkspaceEvalJob(ctx.projectId, jobId));
        if (ctx.json) return (emitJson({ ok: true, job_id: jobId }), 0);
        process.stdout.write(`  Deleted ${jobId}\n`);
        return 0;
      }
    }
    return 1;
  } catch (err) {
    if (err instanceof Error && !('status' in err)) return fail(err.message);
    return surfaceApiError(err);
  }
}
