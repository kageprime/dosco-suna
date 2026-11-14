/**
 * From the `evals:` section of kortix.yaml (or a Harbor job config file) to a
 * resolved job config and the list of trials it means.
 *
 * Everything is read at one commit, so a job is reproducible: the same commit
 * and config plan the same trials.
 */
import { EVAL_LIMITS, EvalJobConfigSchema, isEvalBuiltinAgent, type EvalJobConfig, type EvalTaskSource } from '@kortix/api-contract';
import { normalizeEvalConfig, readEvalSuites, type EvalConfigIssue, type EvalSuiteDeclaration } from '@kortix/manifest-schema';
import { parse as parseYaml } from 'yaml';
import { isRepoFileNotFoundError, readRepoFile, type GitBackedProject } from '../git';
import type { HarborTask } from './harbor-task';
import { discoverTasks, filterTasks, gitTree, loadTask, projectTree, registryTaskRefs, resolveGitRef, builtinDatasetSource, isBuiltinDataset, type DiscoveredTask, type EvalTaskRef } from './task-source';
import { EvalTrialError } from './scoring';

/** A request the caller must fix: 422 `eval_invalid` with these lines. */
export class EvalConfigError extends Error {
  constructor(readonly violations: string[]) {
    super(violations[0] ?? 'The eval config is not valid.');
    this.name = 'EvalConfigError';
  }
}

const line = (issue: EvalConfigIssue, prefix = ''): string => `${prefix}${issue.path ? `${issue.path}: ` : ''}${issue.message}`;

async function readOptionalFile(project: GitBackedProject, path: string, commit: string): Promise<string | null> {
  try {
    return await readRepoFile(project, path, commit);
  } catch (err) {
    if (isRepoFileNotFoundError(err)) return null;
    throw err;
  }
}

interface ManifestEvals {
  suites: EvalSuiteDeclaration[];
  /** Agent names a suite may name; null when the manifest cannot say (no manifest, or built-in agents on). */
  agents: string[] | null;
  /** The names under `agents:`, in file order. */
  declared: string[];
}

/** The `evals` section and the agent names of the manifest at a commit. */
export async function readManifestEvals(project: GitBackedProject, commit: string): Promise<ManifestEvals> {
  const candidates = [project.manifestPath, 'kortix.yaml', 'kortix.yml'].filter((path, i, all) => path && all.indexOf(path) === i);
  for (const path of candidates) {
    const raw = await readOptionalFile(project, path, commit);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new EvalConfigError([`${path} is not valid YAML at ${commit.slice(0, 7)}.`]);
    }
    const manifest = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const declared = typeof manifest.agents === 'object' && manifest.agents !== null ? Object.keys(manifest.agents) : [];
    const builtins = typeof manifest.builtin_agents === 'object' && manifest.builtin_agents !== null && Object.values(manifest.builtin_agents).some(Boolean);
    return { suites: readEvalSuites(manifest.evals), agents: builtins || declared.length === 0 ? null : declared, declared };
  }
  return { suites: [], agents: null, declared: [] };
}

export interface ResolvedSuite {
  name: string;
  source: 'inline' | 'config';
  configPath: string | null;
  config: EvalJobConfig | null;
  error: string | null;
  warnings: string[];
}

/** Field-by-field merge: a later layer replaces a whole top-level field of an earlier one. */
const layered = (...layers: Array<Record<string, unknown> | undefined>): Record<string, unknown> =>
  Object.assign({}, ...layers.map((layer) => Object.fromEntries(Object.entries(layer ?? {}).filter(([, value]) => value !== undefined))));

/** Resolve one declared suite: read its config file when it names one, then validate. */
export async function resolveSuite(project: GitBackedProject, commit: string, suite: EvalSuiteDeclaration, overrides?: Record<string, unknown>): Promise<ResolvedSuite> {
  const errors = suite.issues.filter((issue) => issue.severity === 'error').map((issue) => line(issue));
  const warnings = suite.issues.filter((issue) => issue.severity === 'warning').map((issue) => line(issue));
  let base: Record<string, unknown> = {};
  if (suite.configPath && errors.length === 0) {
    const raw = await readOptionalFile(project, suite.configPath, commit);
    if (raw === null) errors.push(`config: ${suite.configPath} does not exist at ${commit.slice(0, 7)}.`);
    else {
      let parsed: unknown = null;
      try {
        parsed = suite.configPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
      } catch {
        errors.push(`config: ${suite.configPath} is not valid ${suite.configPath.endsWith('.json') ? 'JSON' : 'YAML'}.`);
      }
      if (parsed !== null) {
        const file = normalizeEvalConfig(parsed);
        for (const issue of file.issues) (issue.severity === 'error' ? errors : warnings).push(line(issue, `${suite.configPath}: `));
        base = file.config;
      }
    }
  }
  // A request's fields go through the same reader as kortix.yaml: aliases, `agents: [oracle]`, ignored-key warnings.
  let requested: Record<string, unknown> | undefined;
  if (overrides) {
    const read = normalizeEvalConfig(overrides);
    for (const issue of read.issues) (issue.severity === 'error' ? errors : warnings).push(line(issue, 'config.'));
    requested = read.config;
  }
  const result: ResolvedSuite = { name: suite.name, source: suite.configPath ? 'config' : 'inline', configPath: suite.configPath, config: null, error: null, warnings };
  if (errors.length) return { ...result, error: errors.join(' ') };
  const parsed = EvalJobConfigSchema.safeParse(layered(base, suite.config, requested));
  if (!parsed.success) return { ...result, error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ') };
  if (parsed.data.tasks.length + parsed.data.datasets.length === 0) return { ...result, error: 'The config names no `tasks` and no `datasets`.' };
  return { ...result, config: parsed.data };
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface PlannedTask {
  name: string;
  ref: EvalTaskRef;
  task: HarborTask;
}

export interface PlannedTrial {
  trialName: string;
  taskName: string;
  taskRef: EvalTaskRef;
  agent: string;
  model: string | null;
  attempt: number;
}

/** The label a source's tasks score under: `name@version` of a dataset, `repo:path` of a git source, else the path. */
export function sourceLabel(source: EvalTaskSource): string {
  if (source.name && !source.git_url) return source.version ? `${source.name}@${source.version}` : source.name;
  if (source.git_url) {
    const repo = source.git_url.replace(/\.git$/, '').split('/').slice(-1)[0] ?? source.git_url;
    return source.path ? `${repo}:${source.path}` : repo;
  }
  return source.path ?? '';
}

const labelled = (tasks: DiscoveredTask[], label: string): DiscoveredTask[] => tasks.map((entry) => ({ ...entry, ref: { ...entry.ref, source: label } }));

/** How many trials one task plans: distinct agents × attempts. */
const trialsPerTask = (config: EvalJobConfig): number => new Set(config.agents.map((agent) => `${agent.name}\u0000${agent.model_name ?? ''}`)).size * config.n_attempts;

async function tasksOfSource(project: GitBackedProject, commit: string, source: EvalTaskSource, violations: string[], budget = Number.POSITIVE_INFINITY): Promise<DiscoveredTask[]> {
  return labelled(await readSource(project, commit, source, violations, budget), sourceLabel(source));
}

async function readSource(project: GitBackedProject, commit: string, source: EvalTaskSource, violations: string[], budget: number): Promise<DiscoveredTask[]> {
  if (!source.git_url && source.name && isBuiltinDataset(source.name)) {
    const builtin = builtinDatasetSource(source.name, source.version);
    const found: string[] = [];
    const tasks = await readSource(project, commit, { ...source, ...builtin, name: null, version: null }, found, budget);
    // Name the dataset, not the repository path behind it.
    violations.push(...found.map(() => `The built-in dataset ${source.name} has no tasks at ${builtin.git_commit_id} of the Kortix repository. Pin a version that has it, e.g. version: dev after it ships.`));
    return tasks;
  }
  if (source.git_url) {
    let commit: string;
    try {
      commit = await resolveGitRef(source.git_url, source.git_commit_id);
    } catch (err) {
      violations.push(err instanceof Error ? err.message : String(err));
      return [];
    }
    const gitUrl = source.git_url;
    const found = await discoverTasks(gitTree(gitUrl, commit), source.path ?? '', (path) => ({ kind: 'git', git_url: gitUrl, commit, path }));
    if (found.length === 0) violations.push(`${gitUrl}@${commit.slice(0, 7)}:${source.path ?? ''}: no task found.`);
    return filterTasks(found, source);
  }
  if (source.path) {
    const found = await discoverTasks(projectTree(project, commit), source.path, (path) => ({ kind: 'repo', path }));
    if (found.length === 0) violations.push(`${source.path}: no task found at ${commit.slice(0, 7)}. A task is a folder with task.toml, instruction.md and tests/test.sh.`);
    return filterTasks(found, source);
  }
  if (!source.name) {
    violations.push('A task source needs `path` (a repository path) or `name` (a Harbor registry dataset).');
    return [];
  }
  let refs: Awaited<ReturnType<typeof registryTaskRefs>>;
  try {
    refs = await registryTaskRefs(source.name, source.version);
  } catch (err) {
    violations.push(err instanceof Error ? err.message : String(err));
    return [];
  }
  // Filter by the registry's names first, so `n_tasks: 3` fetches three tasks, not the whole dataset.
  const kept = filterTasks(refs.map((entry) => ({ ref: { ...entry.ref, path: entry.ref.path }, task: null, error: null, name: entry.name })), source);
  // Refuse a job over the trial cap before reading a single task of a large dataset.
  if (kept.length > budget) {
    throw new EvalConfigError([`The dataset ${source.name} selects ${kept.length} tasks, more than this job may run (${EVAL_LIMITS.max_trials_per_job} trials). Set \`n_tasks\` or \`task_names\`.`]);
  }
  const out: DiscoveredTask[] = [];
  for (const entry of kept) {
    if (entry.ref.kind !== 'git') continue;
    try {
      out.push({ ref: entry.ref, task: await loadTask(gitTree(entry.ref.git_url, entry.ref.commit), entry.ref), error: null });
    } catch (err) {
      if (!(err instanceof EvalTrialError)) throw err;
      out.push({ ref: entry.ref, task: null, error: err.message });
    }
  }
  return out;
}

/** Every task the config names, once per task name. A folder that is no task is a violation. */
export async function planTasks(project: GitBackedProject, commit: string, config: EvalJobConfig): Promise<PlannedTask[]> {
  const violations: string[] = [];
  const byName = new Map<string, PlannedTask>();
  const perTask = Math.max(1, trialsPerTask(config));
  for (const source of [...config.tasks, ...config.datasets]) {
    const budget = Math.floor(EVAL_LIMITS.max_trials_per_job / perTask) - byName.size;
    for (const found of await tasksOfSource(project, commit, source, violations, budget)) {
      if (!found.task) {
        violations.push(found.error ?? `${found.ref.path}: not a task.`);
        continue;
      }
      if (!byName.has(found.task.name)) byName.set(found.task.name, { name: found.task.name, ref: found.ref, task: found.task });
    }
  }
  if (violations.length) throw new EvalConfigError(violations);
  if (byName.size === 0) throw new EvalConfigError(['The config selects no task. Check `task_names`, `exclude_task_names` and `n_tasks`.']);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';

/** tasks × agents × attempts, each with a name that is unique in the job and safe as a folder name. */
export function planTrials(config: EvalJobConfig, tasks: readonly PlannedTask[]): PlannedTrial[] {
  // Two entries of one agent with different models need the model in the name.
  const agentCount = new Map<string, number>();
  for (const agent of config.agents) agentCount.set(agent.name, (agentCount.get(agent.name) ?? 0) + 1);
  const trials: PlannedTrial[] = [];
  const seen = new Set<string>();
  for (const agent of config.agents) {
    const model = isEvalBuiltinAgent(agent.name) ? null : (agent.model_name ?? null);
    const agentSlug = (agentCount.get(agent.name) ?? 0) > 1 && model ? `${slug(agent.name)}-${slug(model)}` : slug(agent.name);
    for (const task of tasks) {
      for (let attempt = 1; attempt <= config.n_attempts; attempt += 1) {
        const trialName = `${slug(task.name)}__${agentSlug}__${attempt}`;
        // The same agent and model listed twice plans one set of trials.
        if (seen.has(trialName)) continue;
        seen.add(trialName);
        trials.push({ trialName, taskName: task.name, taskRef: task.ref, agent: agent.name, model, attempt });
      }
    }
  }
  if (trials.length > EVAL_LIMITS.max_trials_per_job) {
    throw new EvalConfigError([`The job plans ${trials.length} trials. The limit is ${EVAL_LIMITS.max_trials_per_job}: lower n_attempts, or select fewer tasks or agents.`]);
  }
  return trials;
}

/** Agents the config names that the manifest does not declare. */
export function unknownAgents(config: EvalJobConfig, declared: readonly string[] | null): string[] {
  if (!declared) return [];
  return config.agents.map((agent) => agent.name).filter((name) => !isEvalBuiltinAgent(name) && name !== 'default' && !declared.includes(name));
}
