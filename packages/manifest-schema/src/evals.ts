/**
 * `evals`: suite name → a job config, in the field names of a Harbor job
 * config (https://github.com/harbor-framework/harbor), or `config: <path>` to
 * a Harbor job config file in the repository.
 *
 *   evals:
 *     smoke:
 *       tasks: evals/tasks            # a task folder or a folder of task folders
 *       agents: [{ name: default }]
 *       n_attempts: 3
 *     nightly:
 *       config: evals/nightly.yaml    # a Harbor job config, read as is
 *
 * `normalizeEvalConfig` is the one reader of both forms: the manifest
 * validator and the API (which reads a `config:` file) share it, so a suite
 * means the same inline and in a file.
 */
import { SLUG_RE } from './constants';

export interface EvalConfigIssue {
  /** Path below the suite, e.g. `agents[0].name`. Empty for the suite itself. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Job config fields Kortix reads. */
const READ_KEYS = new Set([
  'job_name',
  'n_attempts',
  'n_concurrent_trials',
  'timeout_multiplier',
  'agent_timeout_multiplier',
  'verifier_timeout_multiplier',
  'retry',
  'override_error_policy',
  'agents',
  'tasks',
  'datasets',
  'metrics',
  'environment',
  'verifier',
]);

/** Harbor job config fields that mean nothing on Kortix: accepted, ignored, one warning each. */
const IGNORED_KEYS: Record<string, string> = {
  jobs_dir: 'results go to the Evals folder in Files',
  quiet: 'there is no terminal progress display',
  debug: 'there is no debug log switch',
  install_only: 'a Kortix agent needs no install step',
  agent_setup_timeout_multiplier: 'a Kortix agent has no setup phase',
  environment_build_timeout_multiplier: 'sandbox templates build outside the job',
  user_agent: 'simulated users are not supported',
  artifacts: 'job-level artifacts are not supported',
  plugins: 'Harbor plugins do not run on Kortix',
  orchestrator: 'the Kortix runner orchestrates every job',
};

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRepoPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !value.startsWith('/') &&
  !value.split('/').some((segment) => segment === '..');

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A `tasks` / `datasets` value: one path, a list of paths, or a list of `{ path, … }` tables. */
function normalizeSources(raw: unknown, key: string, issues: EvalConfigIssue[]): Array<Record<string, unknown>> {
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) {
    issues.push({ path: key, message: 'must be a repository path or a list of them.', severity: 'error' });
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  list.forEach((entry, i) => {
    const at = `${key}[${i}]`;
    const table = typeof entry === 'string' ? { path: entry } : entry;
    if (!isTable(table)) {
      issues.push({ path: at, message: 'must be a repository path or a table with `path`.', severity: 'error' });
      return;
    }
    if (table.name !== undefined || table.registry !== undefined || table.git_url !== undefined || table.version !== undefined) {
      if (typeof table.name !== 'string' || !table.name.trim()) {
        issues.push({ path: at, message: 'a registry dataset needs `name` (and optionally `version`).', severity: 'error' });
        return;
      }
      if (table.path === undefined) {
        out.push({
          name: table.name,
          ...(table.version !== undefined ? { version: String(table.version) } : {}),
          ...(Array.isArray(table.task_names) ? { task_names: table.task_names } : {}),
          ...(Array.isArray(table.exclude_task_names) ? { exclude_task_names: table.exclude_task_names } : {}),
          ...(typeof table.n_tasks === 'number' ? { n_tasks: table.n_tasks } : {}),
        });
        return;
      }
    }
    const gitUrl = table.git_url ?? table.repo;
    if (gitUrl !== undefined) {
      if (typeof gitUrl !== 'string' || !/^https:\/\//.test(gitUrl)) {
        issues.push({ path: `${at}.git_url`, message: 'must be an https URL of a public git repository.', severity: 'error' });
        return;
      }
      const ref = table.git_commit_id ?? table.ref;
      if (ref !== undefined && typeof ref !== 'string') issues.push({ path: `${at}.ref`, message: 'must be a commit, branch or tag.', severity: 'error' });
      if (table.path !== undefined && (typeof table.path !== 'string' || table.path.startsWith('/') || table.path.split('/').includes('..'))) {
        issues.push({ path: `${at}.path`, message: 'must be a path inside that repository (no leading `/`, no `..`).', severity: 'error' });
        return;
      }
      out.push({
        git_url: gitUrl,
        ...(typeof ref === 'string' ? { git_commit_id: ref } : {}),
        path: typeof table.path === 'string' ? table.path.replace(/^\.\//, '').replace(/\/+$/, '') : '',
        ...(Array.isArray(table.task_names) ? { task_names: table.task_names } : {}),
        ...(Array.isArray(table.exclude_task_names) ? { exclude_task_names: table.exclude_task_names } : {}),
        ...(typeof table.n_tasks === 'number' ? { n_tasks: table.n_tasks } : {}),
      });
      return;
    }
    if (!isRepoPath(table.path)) {
      issues.push({ path: `${at}.path`, message: 'must be a path inside the repository (no leading `/`, no `..`).', severity: 'error' });
      return;
    }
    for (const filter of ['task_names', 'exclude_task_names'] as const) {
      if (table[filter] != null && !(Array.isArray(table[filter]) && (table[filter] as unknown[]).every((n) => typeof n === 'string'))) {
        issues.push({ path: `${at}.${filter}`, message: 'must be a list of task name patterns.', severity: 'error' });
      }
    }
    if (table.n_tasks != null && !(Number.isInteger(table.n_tasks) && (table.n_tasks as number) > 0)) {
      issues.push({ path: `${at}.n_tasks`, message: 'must be a positive integer.', severity: 'error' });
    }
    out.push({
      path: (table.path as string).replace(/^\.\//, '').replace(/\/+$/, ''),
      ...(Array.isArray(table.task_names) ? { task_names: table.task_names } : {}),
      ...(Array.isArray(table.exclude_task_names) ? { exclude_task_names: table.exclude_task_names } : {}),
      ...(typeof table.n_tasks === 'number' ? { n_tasks: table.n_tasks } : {}),
    });
  });
  return out;
}

function normalizeAgents(raw: unknown, issues: EvalConfigIssue[]): Array<Record<string, unknown>> {
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0) {
    issues.push({ path: 'agents', message: 'must be a non-empty list of agents.', severity: 'error' });
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  list.forEach((entry, i) => {
    const at = `agents[${i}]`;
    const table = typeof entry === 'string' ? { name: entry } : entry;
    if (!isTable(table) || typeof table.name !== 'string' || !table.name.trim()) {
      issues.push({
        path: at,
        message: table && isTable(table) && table.import_path
          ? '`import_path` agents (Harbor Python classes) do not run on Kortix. Name a Kortix agent of this project, or `oracle` / `nop`.'
          : 'needs `name`: a Kortix agent of this project, or `oracle` / `nop`.',
        severity: 'error',
      });
      return;
    }
    if (table.model_name != null && typeof table.model_name !== 'string') {
      issues.push({ path: `${at}.model_name`, message: 'must be a `provider/model` string.', severity: 'error' });
    }
    for (const key of ['override_timeout_sec', 'max_timeout_sec'] as const) {
      if (table[key] != null && !positive(table[key])) issues.push({ path: `${at}.${key}`, message: 'must be a positive number of seconds.', severity: 'error' });
    }
    for (const key of ['kwargs', 'env', 'import_path', 'override_setup_timeout_sec'] as const) {
      if (table[key] != null) issues.push({ path: `${at}.${key}`, message: `\`${key}\` is a Harbor agent option; Kortix ignores it.`, severity: 'warning' });
    }
    out.push({
      name: table.name.trim(),
      ...(typeof table.model_name === 'string' ? { model_name: table.model_name } : {}),
      ...(positive(table.override_timeout_sec) ? { override_timeout_sec: table.override_timeout_sec } : {}),
      ...(positive(table.max_timeout_sec) ? { max_timeout_sec: table.max_timeout_sec } : {}),
    });
  });
  return out;
}

/**
 * One job config, inline or from a Harbor config file, as the fields Kortix
 * reads. Every problem is an issue; a config with an `error` issue must not run.
 */
export function normalizeEvalConfig(raw: unknown): { config: Record<string, unknown>; issues: EvalConfigIssue[] } {
  const issues: EvalConfigIssue[] = [];
  const config: Record<string, unknown> = {};
  if (!isTable(raw)) {
    issues.push({ path: '', message: 'must be a table of job config fields.', severity: 'error' });
    return { config, issues };
  }
  for (const key of Object.keys(raw)) {
    if (key === 'config' || READ_KEYS.has(key)) continue;
    issues.push({
      path: key,
      message: IGNORED_KEYS[key] ? `\`${key}\` is ignored on Kortix: ${IGNORED_KEYS[key]}.` : `\`${key}\` is not a job config field Kortix reads; it is ignored.`,
      severity: 'warning',
    });
  }
  if (raw.job_name != null) {
    if (typeof raw.job_name === 'string' && raw.job_name.trim()) config.job_name = raw.job_name.trim();
    else issues.push({ path: 'job_name', message: 'must be a non-empty string.', severity: 'error' });
  }
  for (const key of ['n_attempts', 'n_concurrent_trials'] as const) {
    if (raw[key] == null) continue;
    if (Number.isInteger(raw[key]) && (raw[key] as number) >= 1) config[key] = raw[key];
    else issues.push({ path: key, message: 'must be an integer of 1 or more.', severity: 'error' });
  }
  for (const key of ['timeout_multiplier', 'agent_timeout_multiplier', 'verifier_timeout_multiplier'] as const) {
    if (raw[key] == null) continue;
    if (positive(raw[key])) config[key] = raw[key];
    else issues.push({ path: key, message: 'must be a positive number.', severity: 'error' });
  }
  if (raw.retry != null) {
    if (isTable(raw.retry)) {
      const retry: Record<string, unknown> = {};
      if (raw.retry.max_retries != null) {
        if (Number.isInteger(raw.retry.max_retries) && (raw.retry.max_retries as number) >= 0) retry.max_retries = raw.retry.max_retries;
        else issues.push({ path: 'retry.max_retries', message: 'must be an integer of 0 or more.', severity: 'error' });
      }
      for (const key of ['include_exceptions', 'exclude_exceptions'] as const) {
        if (raw.retry[key] == null) continue;
        if (Array.isArray(raw.retry[key]) && (raw.retry[key] as unknown[]).every((n) => typeof n === 'string')) retry[key] = raw.retry[key];
        else issues.push({ path: `retry.${key}`, message: 'must be a list of exception type names.', severity: 'error' });
      }
      config.retry = retry;
    } else issues.push({ path: 'retry', message: 'must be a table: { max_retries }.', severity: 'error' });
  }
  if (raw.override_error_policy != null) {
    if (isTable(raw.override_error_policy) && Object.values(raw.override_error_policy).every(isTable)) config.override_error_policy = raw.override_error_policy;
    else issues.push({ path: 'override_error_policy', message: 'must map an exception type to { should_retry, should_grade, has_valid_reward }.', severity: 'error' });
  }
  if (raw.agents != null) config.agents = normalizeAgents(raw.agents, issues);
  // A path is a task when it holds task.toml and a dataset otherwise; the reader decides, so both keys take either.
  if (raw.tasks != null) config.tasks = normalizeSources(raw.tasks, 'tasks', issues);
  if (raw.datasets != null) config.datasets = normalizeSources(raw.datasets, 'datasets', issues);
  if (raw.metrics != null) {
    const list = Array.isArray(raw.metrics) ? raw.metrics : null;
    if (!list) issues.push({ path: 'metrics', message: 'must be a list of { type }.', severity: 'error' });
    else {
      config.metrics = list.flatMap((entry, i) => {
        const type = typeof entry === 'string' ? entry : isTable(entry) ? entry.type ?? 'mean' : null;
        if (type === 'mean' || type === 'sum' || type === 'min' || type === 'max') return [{ type }];
        issues.push({
          path: `metrics[${i}]`,
          message: type === 'uv-script' ? 'a `uv-script` metric (metric.py) does not run on Kortix. Use mean, sum, min or max.' : 'type must be mean, sum, min or max.',
          severity: 'error',
        });
        return [];
      });
    }
  }
  if (raw.environment != null) {
    if (isTable(raw.environment)) {
      const env: Record<string, unknown> = {};
      if (raw.environment.type != null || raw.environment.import_path != null) {
        issues.push({ path: 'environment.type', message: 'every trial runs in a Kortix session sandbox; the Harbor environment type is ignored.', severity: 'warning' });
      }
      if (raw.environment.sandbox != null) {
        if (typeof raw.environment.sandbox === 'string' && raw.environment.sandbox.trim()) env.sandbox = raw.environment.sandbox.trim();
        else issues.push({ path: 'environment.sandbox', message: 'must be a `sandbox.templates` slug.', severity: 'error' });
      }
      if (raw.environment.delete != null) {
        if (typeof raw.environment.delete === 'boolean') env.delete = raw.environment.delete;
        else issues.push({ path: 'environment.delete', message: 'must be true or false.', severity: 'error' });
      }
      config.environment = env;
    } else issues.push({ path: 'environment', message: 'must be a table.', severity: 'error' });
  }
  if (raw.verifier != null) {
    if (isTable(raw.verifier)) {
      const verifier: Record<string, unknown> = {};
      if (raw.verifier.disable != null) {
        if (typeof raw.verifier.disable === 'boolean') verifier.disable = raw.verifier.disable;
        else issues.push({ path: 'verifier.disable', message: 'must be true or false.', severity: 'error' });
      }
      if (raw.verifier.env != null) {
        if (isTable(raw.verifier.env) && Object.values(raw.verifier.env).every((v) => typeof v === 'string')) verifier.env = raw.verifier.env;
        else issues.push({ path: 'verifier.env', message: 'must map a variable name to a string.', severity: 'error' });
      }
      config.verifier = verifier;
    } else issues.push({ path: 'verifier', message: 'must be a table.', severity: 'error' });
  }
  return { config, issues };
}

export interface EvalSuiteDeclaration {
  name: string;
  /** Set when the suite points at a Harbor job config file. */
  configPath: string | null;
  /** The inline job config fields (empty with `configPath`). */
  config: Record<string, unknown>;
  issues: EvalConfigIssue[];
}

/** The suites of an `evals` section, each with its own issues. A non-table section has none. */
export function readEvalSuites(node: unknown): EvalSuiteDeclaration[] {
  if (!isTable(node)) return [];
  return Object.entries(node).map(([name, raw]) => {
    if (isTable(raw) && raw.config != null) {
      const issues: EvalConfigIssue[] = [];
      if (!isRepoPath(raw.config) || !/\.(ya?ml|json)$/i.test(raw.config)) {
        issues.push({ path: 'config', message: 'must be a repository path to a `.yaml`, `.yml` or `.json` Harbor job config.', severity: 'error' });
      }
      const overrides = normalizeEvalConfig(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'config')));
      return { name, configPath: typeof raw.config === 'string' ? raw.config.replace(/^\.\//, '') : null, config: overrides.config, issues: [...issues, ...overrides.issues] };
    }
    const { config, issues } = normalizeEvalConfig(raw);
    if (isTable(raw) && !((config.tasks as unknown[] | undefined)?.length || (config.datasets as unknown[] | undefined)?.length) && !issues.some((i) => i.severity === 'error')) {
      issues.push({ path: '', message: 'needs `tasks` or `datasets` (a repository path of Harbor-format tasks), or `config` (a Harbor job config file).', severity: 'error' });
    }
    return { name, configPath: null, config, issues };
  });
}

/** Validate the `evals` section of kortix.yaml. `agents`: the project's agent names, to warn on an unknown one. */
export function validateEvals(
  node: unknown,
  path: string,
  issues: Array<{ path: string; message: string; severity: 'error' | 'warning' }>,
  agents?: readonly string[],
): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: 'must be a table: suite name → job config. Example: `evals: { smoke: { tasks: evals/tasks } }`.', severity: 'error' });
    return;
  }
  for (const suite of readEvalSuites(node)) {
    const where = `${path}.${suite.name}`;
    if (!SLUG_RE.test(suite.name)) {
      issues.push({ path: where, message: `"${suite.name}" is not a valid suite name: lowercase letters, digits, "-" and "_".`, severity: 'error' });
    }
    for (const issue of suite.issues) {
      issues.push({ path: issue.path ? `${where}.${issue.path}` : where, message: issue.message, severity: issue.severity });
    }
    if (!agents) continue;
    ((suite.config.agents as Array<{ name: string }> | undefined) ?? []).forEach((agent, i) => {
      if (agent.name === 'oracle' || agent.name === 'nop' || agent.name === 'default' || agents.includes(agent.name)) return;
      issues.push({
        path: `${where}.agents[${i}].name`,
        message: `"${agent.name}" is not an agent of this project. Agents: ${[...agents, 'oracle', 'nop'].join(', ')}.`,
        severity: 'error',
      });
    });
  }
}
