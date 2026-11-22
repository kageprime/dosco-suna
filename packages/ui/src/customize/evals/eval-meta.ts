import {
  evalJobScore,
  evalTrialScore,
  type WorkspaceEvalJob,
  type WorkspaceEvalTrial,
} from '@kortix/sdk';

import { adminPath } from '../../lib/routes';

/**
 * The Evals group of Customize: Overview, Datasets, Tasks, Jobs. A dataset is
 * a suite of kortix.yaml or a dataset by name (built-in or Harbor registry);
 * its URL is `/admin/eval-datasets/suite/<name>` or
 * `/admin/eval-datasets/dataset/<org>/<name>?version=`.
 */
export const evalsHref = (projectId: string): string => adminPath(projectId, 'evals');
export const evalDatasetsHref = (projectId: string): string => adminPath(projectId, 'eval-datasets');
export const evalTasksHref = (projectId: string): string => adminPath(projectId, 'eval-tasks');
export const evalJobsHref = (projectId: string): string => adminPath(projectId, 'eval-jobs');

export const evalJobHref = (projectId: string, jobId: string, trialId?: string | null): string =>
  `${evalJobsHref(projectId)}/${encodeURIComponent(jobId)}${trialId ? `?trial=${encodeURIComponent(trialId)}` : ''}`;

/** Jobs side by side; the first is the baseline. */
export const evalCompareHref = (projectId: string, jobIds: string[]): string =>
  `${evalJobsHref(projectId)}/compare?jobs=${jobIds.map(encodeURIComponent).join(',')}`;

/** A suite of kortix.yaml, or a dataset by name and version. */
export type EvalDatasetRef =
  | { kind: 'suite'; name: string }
  | { kind: 'dataset'; name: string; version?: string | null };

export const datasetKey = (ref: EvalDatasetRef): string =>
  ref.kind === 'suite' ? `suite:${ref.name}` : `dataset:${ref.name}`;

/** `smoke`, or `kortix/my-kortix@1.0`: how a dataset is named in text. */
export const datasetLabel = (ref: EvalDatasetRef): string =>
  ref.kind === 'dataset' && ref.version ? `${ref.name}@${ref.version}` : ref.name;

export const evalDatasetHref = (projectId: string, ref: EvalDatasetRef, tab?: string): string => {
  const path = ref.name.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams({
    ...(ref.kind === 'dataset' && ref.version ? { version: ref.version } : {}),
    ...(tab ? { tab } : {}),
  }).toString();
  return `${evalDatasetsHref(projectId)}/${ref.kind}/${path}${query ? `?${query}` : ''}`;
};

/** The route's catch-all segments (`suite/<name>`, `dataset/<org>/<name>`) back to a ref. */
export function parseDatasetSegments(segments: readonly string[], version: string | null): EvalDatasetRef | null {
  const [kind, ...rest] = segments.map((segment) => decodeURIComponent(segment));
  const name = rest.join('/');
  if (!name) return null;
  if (kind === 'suite') return { kind, name };
  if (kind === 'dataset') return { kind, name, version };
  return null;
}

/** A task opens with the dataset it was reached from, for the breadcrumb and New job. */
export const evalTaskHref = (projectId: string, taskId: string, from?: EvalDatasetRef | null): string => {
  const query = from
    ? `?${new URLSearchParams({ from: from.kind === 'dataset' && from.version ? `${datasetKey(from)}@${from.version}` : datasetKey(from) }).toString()}`
    : '';
  return `${evalTasksHref(projectId)}/${encodeURIComponent(taskId)}${query}`;
};

/** `suite:smoke` or `dataset:kortix/my-kortix@1.0` (the `from` of a task link) back to a ref. */
export function parseDatasetKey(value: string | null | undefined): EvalDatasetRef | null {
  if (!value) return null;
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (!rest) return null;
  if (kind === 'suite') return { kind, name: rest };
  if (kind !== 'dataset') return null;
  const version = rest.lastIndexOf('@');
  return version > 0 ? { kind, name: rest.slice(0, version), version: rest.slice(version + 1) } : { kind, name: rest };
}

/** The dataset a job ran: its suite, else its first named dataset. Null for a job on a repository path. */
export function jobDataset(job: Pick<WorkspaceEvalJob, 'suite' | 'config'>): EvalDatasetRef | null {
  if (job.suite) return { kind: 'suite', name: job.suite };
  const named = job.config.datasets?.find((source) => source.name);
  return named?.name ? { kind: 'dataset', name: named.name, version: named.version ?? null } : null;
}

/**
 * The `kortix evals run` command for a dataset (and a task of it). A suite
 * names its own agents; a dataset needs one, so the command names the first
 * agent the caller has, else a placeholder.
 */
export function runCommand(ref: EvalDatasetRef, options: { agent?: string | null; task?: string | null } = {}): string {
  const task = options.task ? ` --task ${shellWord(options.task)}` : '';
  if (ref.kind === 'suite') return `kortix evals run ${shellWord(ref.name)}${task}`;
  return `kortix evals run --dataset ${shellWord(datasetLabel(ref))}${task} --agent ${shellWord(options.agent || '<agent>')}`;
}

const shellWord = (value: string): string => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** `1.2k`, `3.4M`: a token count in short units. */
export function shortCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  const [size, unit] = units.find(([n]) => value >= n)!;
  return `${(Math.round((value / size) * 10) / 10).toString()}${unit}`;
}

/** `$0.42`, `$12.30`, or an em dash with no cost. Under a cent shows `<$0.01`. */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** `42 s`, `3 m 05 s`, `1 h 02 m`: the time between two instants, or an em dash. */
export function duration(from: string | null | undefined, to: string | null | undefined, now = Date.now()): string {
  if (!from) return '—';
  const ms = (to ? Date.parse(to) : now) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}

/**
 * The 95% interval half-width of a pass rate over `n` valid trials (normal
 * approximation): two runs whose intervals overlap are not a clear change.
 */
export function passInterval(rate: number | null | undefined, n: number): number | null {
  if (rate === null || rate === undefined || n < 2) return null;
  return 1.96 * Math.sqrt((rate * (1 - rate)) / n);
}

/** `82.5%`, or an em dash with no value. */
export const percent = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`;

export const isOpenJob = (job: Pick<WorkspaceEvalJob, 'status'>): boolean =>
  job.status === 'queued' || job.status === 'running';

/** `agent` or `agent @ model`: the one label an agent × model goes by on every surface. */
export const agentLabel = (agent: string, model: string | null | undefined): string =>
  model ? `${agent} @ ${model}` : agent;

export type CellTone = 'pass' | 'fail' | 'error' | 'running' | 'queued' | 'cancelled';

/** What one trial's cell shows. */
export function trialTone(trial: WorkspaceEvalTrial): CellTone {
  if (trial.status === 'cancelled') return 'cancelled';
  if (trial.status === 'queued') return 'queued';
  if (
    trial.status === 'starting' ||
    trial.status === 'agent_running' ||
    trial.status === 'verifying'
  )
    return 'running';
  const { passed, score } = evalTrialScore(trial);
  if (score === null) return trial.exception ? 'error' : 'fail';
  return passed ? 'pass' : 'fail';
}

/** The last run of each attempt stands for it: a retry replaces the run before it. */
export function latestRuns(trials: WorkspaceEvalTrial[]): WorkspaceEvalTrial[] {
  const last = new Map<string, WorkspaceEvalTrial>();
  for (const trial of trials) {
    const key = `${trial.task_name}\u0000${trial.agent}\u0000${trial.model ?? ''}\u0000${trial.attempt}`;
    const seen = last.get(key);
    if (!seen || seen.retry < trial.retry) last.set(key, trial);
  }
  return [...last.values()];
}

/**
 * What a job measured: its suite, else (a job started without one) its first
 * source: a registry dataset `terminal-bench@2.0`, or a repository path.
 */
export function jobSource(job: Pick<WorkspaceEvalJob, 'suite' | 'config'>): string {
  if (job.suite) return job.suite;
  const git = [...(job.config.tasks ?? []), ...(job.config.datasets ?? [])].find(
    (source) => source.git_url,
  );
  if (git?.git_url) {
    const repo = git.git_url
      .replace(/\.git$/, '')
      .split('/')
      .slice(-1)[0];
    return git.path ? `${repo}:${git.path}` : repo!;
  }
  const dataset = job.config.datasets?.find((source) => source.name);
  if (dataset?.name) return dataset.version ? `${dataset.name}@${dataset.version}` : dataset.name;
  return job.config.tasks?.[0]?.path ?? job.config.datasets?.[0]?.path ?? '—';
}

export interface LeaderboardRow {
  suite: string;
  /** The dataset the row's jobs ran, when they ran one (a suite or a named dataset). */
  dataset: EvalDatasetRef | null;
  agent: string;
  model: string | null;
  /** Pass@1, else the first metric for graded rewards. */
  passAt1: number | null;
  /** Valid trials of the latest job. */
  n: number;
  /** Pass@1 change against the job before the latest one; null with one job. */
  change: number | null;
  jobs: number;
  lastJob: WorkspaceEvalJob;
}

/**
 * One row per suite × agent × model: the score of its latest completed job,
 * and the change against the completed job before it. `jobs` is newest first.
 */
export function leaderboard(jobs: WorkspaceEvalJob[]): LeaderboardRow[] {
  const series = new Map<string, Array<{ job: WorkspaceEvalJob; passAt1: number | null; n: number }>>();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    for (const stats of job.stats.agents) {
      if (stats.n_trials === 0) continue;
      const source = stats.source ? `${jobSource(job)} · ${stats.source}` : jobSource(job);
      const key = `${source}\u0000${stats.agent}\u0000${stats.model ?? ''}`;
      // Pass@1, else (graded rewards) the mean of the first metric over its keys, as `evalJobScore` reads it.
      const metric = Object.values(stats.metrics[0] ?? {});
      const value = stats.pass_at_k['1'] ?? (metric.length ? metric.reduce((a, b) => a + b, 0) / metric.length : null);
      series.set(key, [...(series.get(key) ?? []), { job, passAt1: value, n: stats.n_trials }]);
    }
  }
  const rows: LeaderboardRow[] = [];
  for (const [key, runs] of series) {
    const [suite, agent, model] = key.split('\u0000') as [string, string, string];
    const [latest, previous] = runs;
    rows.push({
      suite,
      dataset: jobDataset(latest!.job),
      agent,
      model: model || null,
      passAt1: latest!.passAt1,
      n: latest!.n,
      change:
        previous && latest!.passAt1 !== null && previous.passAt1 !== null
          ? latest!.passAt1 - previous.passAt1
          : null,
      jobs: runs.length,
      lastJob: latest!.job,
    });
  }
  return rows.sort(
    (a, b) => a.suite.localeCompare(b.suite) || (b.passAt1 ?? -1) - (a.passAt1 ?? -1),
  );
}

/** Rank by score within one board, tied rows sharing a rank (`1, 2, 2, 4`). */
export function ranked<T extends { passAt1: number | null }>(rows: T[]): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => (b.passAt1 ?? -1) - (a.passAt1 ?? -1));
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || sorted[i - 1]!.passAt1 !== row.passAt1) rank = i + 1;
    return { ...row, rank };
  });
}

export { evalJobScore, evalTrialScore };
