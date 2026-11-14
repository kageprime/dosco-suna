/**
 * Evals: `/v1/workspaces/:workspaceId/evals/*` (project flag `evals`).
 *
 * Kortix runs the Harbor task format (https://github.com/harbor-framework/harbor)
 * and keeps Harbor's names: a TASK is an instruction, an environment and a
 * verifier; a TRIAL is one agent's attempt at one task; a JOB is a set of
 * trials (tasks × agents × attempts). The verifier (`tests/test.sh`) writes the
 * REWARD to `/logs/verifier/reward.json` or `/logs/verifier/reward.txt`.
 *
 * A job's config uses Harbor's job config field names, so a Harbor
 * `config.yaml` reads as-is. Two fields mean something else here:
 * `agents[].name` is a Kortix agent of the project (or `oracle` / `nop`), and
 * the sandbox is always a Kortix session sandbox (`environment.type` is
 * ignored).
 *
 * The job folder in the project's Files (`/Evals/<job_name>/`) holds the
 * content of a job in Harbor's `jobs/` layout: `config.json`, `result.json`,
 * and per trial `config.json`, `result.json`, `verifier/`. The `eval_jobs` and
 * `eval_trials` rows are the index of it and the runner's queue state.
 */
import { z } from 'zod';

export const EVAL_LIMITS = {
  /** Trials one job may hold (tasks × agents × attempts). */
  max_trials_per_job: 2_000,
  n_attempts_max: 100,
  n_concurrent_trials_default: 4,
  n_concurrent_trials_max: 32,
  max_retries_max: 10,
  /** Harbor's defaults when `task.toml` names no timeout. */
  agent_timeout_sec_default: 1_800,
  verifier_timeout_sec_default: 600,
  /** Bytes of one task's `tests/` or `solution/` folder. */
  task_folder_bytes_max: 20 * 1024 * 1024,
  /** Bytes kept of one verifier log file. */
  verifier_file_bytes_max: 1024 * 1024,
  job_name_chars: 120,
} as const;

/** The agents that run no model. `oracle` runs `solution/solve.sh`; `nop` does nothing. */
export const EVAL_BUILTIN_AGENTS = ['oracle', 'nop'] as const;
export type EvalBuiltinAgent = (typeof EVAL_BUILTIN_AGENTS)[number];
export const isEvalBuiltinAgent = (name: string): name is EvalBuiltinAgent =>
  (EVAL_BUILTIN_AGENTS as readonly string[]).includes(name);

// ── Job config (Harbor's JobConfig field names) ──────────────────────────────

export const EvalAgentConfigSchema = z.object({
  /** A Kortix agent of the project, or `oracle` / `nop`. */
  name: z.string().min(1).max(120),
  /** `provider/model`. Absent: the agent's own model. */
  model_name: z.string().min(1).max(200).nullish(),
  /** Replaces the task's `agent.timeout_sec`. */
  override_timeout_sec: z.number().positive().nullish(),
  /** Caps the task's `agent.timeout_sec`. */
  max_timeout_sec: z.number().positive().nullish(),
});
export type EvalAgentConfig = z.infer<typeof EvalAgentConfigSchema>;

/**
 * Where tasks come from. `path`: one task folder, or one folder of task
 * folders, in the project repository. `name` (+ `version`): a dataset of the
 * Harbor registry, e.g. `terminal-bench` `2.0`; its tasks are read from the
 * public git repositories the registry names, at the commits it pins.
 */
export const EvalTaskSourceSchema = z.object({
  path: z.string().min(1).max(500).nullish(),
  name: z.string().min(1).max(200).nullish(),
  version: z.string().min(1).max(60).nullish(),
  /** A public git repository (https on github.com, gitlab.com or huggingface.co); `path` is inside it. */
  git_url: z.string().url().max(500).nullish(),
  /** The commit, branch or tag of `git_url`. A branch or tag is resolved to its commit when the job starts. Default: the default branch. */
  git_commit_id: z.string().min(1).max(250).nullish(),
  /** Glob patterns of task names to keep (datasets only). */
  task_names: z.array(z.string().min(1).max(200)).max(500).nullish(),
  exclude_task_names: z.array(z.string().min(1).max(200)).max(500).nullish(),
  /** Keep at most this many tasks, in name order (datasets only). */
  n_tasks: z.number().int().positive().nullish(),
});
export type EvalTaskSource = z.infer<typeof EvalTaskSourceSchema>;

export const EVAL_METRIC_TYPES = ['mean', 'sum', 'min', 'max'] as const;
export const EvalMetricConfigSchema = z.object({ type: z.enum(EVAL_METRIC_TYPES).default('mean') });
export type EvalMetricConfig = z.infer<typeof EvalMetricConfigSchema>;

export const EvalErrorPolicySchema = z.object({
  should_retry: z.boolean(),
  should_grade: z.boolean(),
  has_valid_reward: z.boolean(),
});
export type EvalErrorPolicy = z.infer<typeof EvalErrorPolicySchema>;

export const EvalRetryConfigSchema = z.object({
  max_retries: z.number().int().min(0).max(EVAL_LIMITS.max_retries_max).default(0),
  /** Only these exception types retry. Absent: the error policy decides. */
  include_exceptions: z.array(z.string()).max(100).nullish(),
  /** These exception types never retry. Wins over `include_exceptions`. */
  exclude_exceptions: z.array(z.string()).max(100).nullish(),
});
export type EvalRetryConfig = z.infer<typeof EvalRetryConfigSchema>;

export const EvalJobConfigSchema = z.object({
  job_name: z.string().min(1).max(EVAL_LIMITS.job_name_chars).nullish(),
  n_attempts: z.number().int().min(1).max(EVAL_LIMITS.n_attempts_max).default(1),
  n_concurrent_trials: z
    .number()
    .int()
    .min(1)
    .max(EVAL_LIMITS.n_concurrent_trials_max)
    .default(EVAL_LIMITS.n_concurrent_trials_default),
  timeout_multiplier: z.number().positive().max(100).default(1),
  agent_timeout_multiplier: z.number().positive().max(100).nullish(),
  verifier_timeout_multiplier: z.number().positive().max(100).nullish(),
  retry: EvalRetryConfigSchema.default({ max_retries: 0 }),
  override_error_policy: z.record(z.string(), EvalErrorPolicySchema.partial()).default({}),
  agents: z.array(EvalAgentConfigSchema).min(1).max(20).default([{ name: 'oracle' }]),
  tasks: z.array(EvalTaskSourceSchema).max(500).default([]),
  datasets: z.array(EvalTaskSourceSchema).max(50).default([]),
  metrics: z.array(EvalMetricConfigSchema).max(10).default([]),
  environment: z
    .object({
      /** A `sandbox.templates` slug every trial boots. Absent: each agent's own sandbox. */
      sandbox: z.string().min(1).max(120).nullish(),
      /** Stop each trial's sandbox when the trial ends. */
      delete: z.boolean().default(true),
    })
    .default({ delete: true }),
  verifier: z
    .object({
      /** Run no verifier: trials end with no reward. */
      disable: z.boolean().default(false),
      /** Added to every task's `[verifier.env]`. */
      env: z.record(z.string(), z.string()).default({}),
    })
    .default({ disable: false, env: {} }),
});
export type EvalJobConfig = z.infer<typeof EvalJobConfigSchema>;
/** What a caller sends: every field optional. */
export type EvalJobConfigInput = z.input<typeof EvalJobConfigSchema>;

// ── Suites (the `evals:` section of kortix.yaml) and tasks ───────────────────

export const EvalSuiteSchema = z.object({
  name: z.string(),
  /** `config`: the suite points at a Harbor job config file in the repository. */
  source: z.enum(['inline', 'config']),
  config_path: z.string().nullable(),
  /** Null when the suite does not resolve; `error` says why. */
  config: EvalJobConfigSchema.nullable(),
  error: z.string().nullable(),
  /** Lines the reader should see: an ignored Harbor field, an unknown agent. */
  warnings: z.array(z.string()),
  /** The latest job of the suite, when one ran. */
  last_job: z.lazy(() => EvalJobSchema).nullable(),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const EvalTaskSchema = z.object({
  /**
   * Opaque id of the task at one commit (where it lives and the commit it was
   * read at). `GET /evals/tasks/{task_id}` reads it; stable while the commit is.
   */
  task_id: z.string(),
  /** `[task].name` of task.toml, else the folder name. */
  name: z.string(),
  /** Repository path of the task folder. */
  path: z.string(),
  instruction: z.string(),
  agent_timeout_sec: z.number(),
  verifier_timeout_sec: z.number(),
  has_solution: z.boolean(),
  /** `environment/Dockerfile`, `[environment].docker_image`, or null for the agent's own sandbox. */
  environment: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  /** Why this task cannot run on Kortix, or null. */
  unsupported: z.string().nullable(),
  /** From `[metadata]` of task.toml: `category`, `difficulty`, and `tags` (or `keywords`). */
  category: z.string().nullable(),
  difficulty: z.string().nullable(),
  tags: z.array(z.string()),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/** One file of a task folder. */
/** One file of a task folder: its path relative to the folder and its size in bytes. */
export const EvalTaskFileSchema = z.object({ path: z.string(), size: z.number() });

export const EvalTaskDetailResponseSchema = z.object({
  task: EvalTaskSchema,
  /** The task folder's README.md, or null. */
  readme: z.string().nullable(),
  /** task.toml as written. */
  task_toml: z.string().nullable(),
  /** Every file of the task folder, paths relative to it. */
  files: z.array(EvalTaskFileSchema),
});
export type EvalTaskDetailResponse = z.infer<typeof EvalTaskDetailResponseSchema>;

/** The last run of one attempt of this task in some job: its result and the job it belongs to. */
export const EvalTaskResultSchema = z.object({
  job_id: z.string(),
  job_name: z.string(),
  trial_id: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  attempt: z.number().int(),
  status: z.enum([
    'queued',
    'starting',
    'agent_running',
    'verifying',
    'completed',
    'errored',
    'cancelled',
  ]),
  rewards: z.record(z.string(), z.number()).nullable(),
  reward_valid: z.boolean(),
  exception_type: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type EvalTaskResult = z.infer<typeof EvalTaskResultSchema>;

/** One agent × model on one task, over every ended attempt the results hold. */
export const EvalTaskResultSummarySchema = z.object({
  agent: z.string(),
  model: z.string().nullable(),
  /** Ended attempts whose reward counts. */
  n: z.number().int(),
  /** Of those, attempts with every reward at 1 or above. */
  n_passed: z.number().int(),
  /** Mean over the counted attempts of each attempt's mean reward (over its keys); null with none. */
  mean_reward: z.number().nullable(),
});
export type EvalTaskResultSummary = z.infer<typeof EvalTaskResultSummarySchema>;

export const EvalTaskResultsResponseSchema = z.object({
  results: z.array(EvalTaskResultSchema),
  summary: z.array(EvalTaskResultSummarySchema),
});
export type EvalTaskResultsResponse = z.infer<typeof EvalTaskResultsResponseSchema>;

/**
 * A dataset a job can name by `name` and `version`: a built-in dataset Kortix
 * ships (`kortix/…`), or one of the Harbor registry.
 */
export const EvalDatasetSchema = z.object({
  name: z.string(),
  /** The version a job without one runs. */
  version: z.string(),
  /** Every version, newest first. */
  versions: z.array(z.string()),
  kind: z.enum(['builtin', 'registry']),
  description: z.string(),
  /** Tasks of `version`; null when not known without reading the dataset. */
  n_tasks: z.number().int().nullable(),
});
export type EvalDataset = z.infer<typeof EvalDatasetSchema>;

export const EvalDatasetsResponseSchema = z.object({
  datasets: z.array(EvalDatasetSchema),
  /** Why the Harbor registry could not be read; the built-in datasets are still listed. */
  registry_error: z.string().nullable(),
});
export type EvalDatasetsResponse = z.infer<typeof EvalDatasetsResponseSchema>;

export const EvalSuitesResponseSchema = z.object({ suites: z.array(EvalSuiteSchema) });
export const EvalTasksResponseSchema = z.object({
  commit: z.string().nullable(),
  tasks: z.array(EvalTaskSchema),
  /** README.md at the root of the dataset (a suite's single task path, a built-in or git dataset folder), or null. */
  readme: z.string().nullable(),
});

// ── Jobs and trials ──────────────────────────────────────────────────────────

export const EVAL_JOB_STATUSES = ['queued', 'running', 'completed', 'cancelled'] as const;
export type EvalJobStatus = (typeof EVAL_JOB_STATUSES)[number];

/**
 * `queued` waits for a slot. `starting` boots the sandbox. `agent_running`
 * runs the agent. `verifying` runs `tests/test.sh`. `completed` ended with no
 * exception; `errored` ended with one (it may still hold a valid reward).
 */
export const EVAL_TRIAL_STATUSES = [
  'queued',
  'starting',
  'agent_running',
  'verifying',
  'completed',
  'errored',
  'cancelled',
] as const;
export type EvalTrialStatus = (typeof EVAL_TRIAL_STATUSES)[number];
export const EVAL_TRIAL_TERMINAL: readonly EvalTrialStatus[] = ['completed', 'errored', 'cancelled'];

export const EvalExceptionSchema = z.object({
  exception_type: z.string(),
  exception_message: z.string(),
  occurred_at: z.string(),
  policy: EvalErrorPolicySchema,
});
export type EvalException = z.infer<typeof EvalExceptionSchema>;

const TimingSchema = z.object({ started_at: z.string().nullable(), finished_at: z.string().nullable() });
export type EvalTiming = z.infer<typeof TimingSchema>;

export const EvalUsageSchema = z.object({
  n_input_tokens: z.number(),
  n_output_tokens: z.number(),
  /** Cache reads and cache writes. */
  n_cache_tokens: z.number(),
  /** What the LLM gateway billed, in USD; null when it recorded no cost. */
  cost_usd: z.number().nullable(),
});
export type EvalUsage = z.infer<typeof EvalUsageSchema>;

export const EvalRewardsSchema = z.record(z.string(), z.number());
export type EvalRewards = z.infer<typeof EvalRewardsSchema>;

export const EvalTrialSchema = z.object({
  trial_id: z.string(),
  job_id: z.string(),
  /** `<task>__<agent>__<attempt>`, the trial's folder name. */
  trial_name: z.string(),
  task_name: z.string(),
  task_path: z.string(),
  /** The task's id at the job's commit: `GET /evals/tasks/{task_id}` reads it. */
  task_id: z.string().nullable(),
  agent: z.string(),
  model: z.string().nullable(),
  /** 1-based attempt of this task × agent. */
  attempt: z.number().int(),
  /** 0 for the first run of the attempt; a retry after an error counts up. */
  retry: z.number().int(),
  status: z.enum(EVAL_TRIAL_STATUSES),
  /** The session the agent ran in. Null until the trial starts. */
  session_id: z.string().nullable(),
  rewards: EvalRewardsSchema.nullable(),
  /** Whether the reward counts in the job's metrics. */
  reward_valid: z.boolean(),
  exception: EvalExceptionSchema.nullable(),
  environment_setup: TimingSchema,
  agent_execution: TimingSchema,
  verifier: TimingSchema,
  /** Token use of the trial's session; refreshed while the agent runs. */
  usage: EvalUsageSchema.nullable(),
  /** Files path of the trial folder. */
  folder: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type EvalTrial = z.infer<typeof EvalTrialSchema>;

/** The score of one agent × model over the tasks of one source of the job (Harbor's grouping). */
export const EvalAgentStatsSchema = z.object({
  agent: z.string(),
  model: z.string().nullable(),
  /** The dataset (`name@version`) or task path the tasks came from; null for a job with one source. */
  source: z.string().nullable(),
  /** Trials whose reward counts. */
  n_trials: z.number().int(),
  /** Trials that ended with an exception. */
  n_errors: z.number().int(),
  /** `{ "<metric>": value }` for one reward key, `{ "<key>": value }` per key for several (the first metric). */
  metrics: z.array(z.record(z.string(), z.number())),
  /**
   * `k` → Harbor's unbiased pass@k, `1 − C(n−c, k) / C(n, k)` averaged over
   * tasks (`n` attempts, `c` of them passed: every reward key is 1). Only when
   * every value of every reward is 0 or 1, with any number of keys (one key is
   * Harbor's rule; several are one 0/1 criterion each). A graded value
   * (strictly between 0 and 1) leaves it empty. `k` is 1 and Harbor's set (2,
   * 4, 8, … and 5, 10, 15, …) up to the fewest attempts of any task.
   */
  pass_at_k: z.record(z.string(), z.number()),
});
export type EvalAgentStats = z.infer<typeof EvalAgentStatsSchema>;

export const EvalJobStatsSchema = z.object({
  n_total_trials: z.number().int(),
  n_queued: z.number().int(),
  n_running: z.number().int(),
  n_completed: z.number().int(),
  n_errored: z.number().int(),
  n_cancelled: z.number().int(),
  /** Runs superseded by a retry (not in `n_total_trials`). */
  n_retries: z.number().int().default(0),
  /** Exception type → trials that ended with it. */
  exception_stats: z.record(z.string(), z.number().int()).default({}),
  /** Token use and cost of every trial so far. */
  usage: EvalUsageSchema.nullable().default(null),
  agents: z.array(EvalAgentStatsSchema),
});
export type EvalJobStats = z.infer<typeof EvalJobStatsSchema>;

export const EvalJobSchema = z.object({
  job_id: z.string(),
  project_id: z.string(),
  /** The `evals:` suite the job ran, or null for an ad-hoc config. */
  suite: z.string().nullable(),
  job_name: z.string(),
  status: z.enum(EVAL_JOB_STATUSES),
  /** The commit the tasks and the config were read at. */
  commit: z.string().nullable(),
  ref: z.string().nullable(),
  config: EvalJobConfigSchema,
  stats: EvalJobStatsSchema,
  /** The job this one re-ran trials of. */
  rerun_of: z.string().nullable(),
  /** Files path of the job folder, and the drive that holds it. */
  folder: z.string(),
  drive_id: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type EvalJob = z.infer<typeof EvalJobSchema>;

export const EvalJobListResponseSchema = z.object({
  jobs: z.array(EvalJobSchema),
  /** Opaque; pass it as `cursor` for the next page. Null on the last page. */
  next_cursor: z.string().nullable(),
  /** Jobs that match the filters, over every page. */
  total: z.number().int(),
});
export const EvalJobResponseSchema = z.object({
  job: EvalJobSchema,
  /** What the config reader noticed and ignored (`POST /jobs` only). */
  warnings: z.array(z.string()).optional(),
});
export const EvalTrialListResponseSchema = z.object({ trials: z.array(EvalTrialSchema) });
export const EvalTrialResponseSchema = z.object({ trial: EvalTrialSchema });

/** `POST /jobs` with `dry_run: true`: what the job would run. Nothing is created. */
export const EvalJobPlanResponseSchema = z.object({
  commit: z.string(),
  n_tasks: z.number().int(),
  n_trials: z.number().int(),
  agents: z.array(z.object({ name: z.string(), model: z.string().nullable() })),
  /** The first 200 task names. */
  tasks: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type EvalJobPlanResponse = z.infer<typeof EvalJobPlanResponseSchema>;

/** One job's result on one compare row. */
export const EvalCompareCellSchema = z.object({
  job_id: z.string(),
  /** Ended attempts whose reward counts (last run of each attempt). */
  n: z.number().int(),
  n_passed: z.number().int(),
  /** `n_passed / n`; null with no counted attempt (not run, or every run errored). */
  pass_rate: z.number().nullable(),
  /** Mean over the counted attempts of each attempt's mean reward (over its keys). */
  mean_reward: z.number().nullable(),
  /** The most frequent exception type among the attempts, or null. */
  exception_type: z.string().nullable(),
});

/**
 * One task (with `by=task_agent_model`: one task × agent × model) across the
 * compared jobs. `change` compares the last job with the first: `better` or
 * `worse` by pass rate, then by mean reward; `only_one` when one side has no
 * counted attempt.
 */
export const EvalCompareRowSchema = z.object({
  task_name: z.string(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  cells: z.array(EvalCompareCellSchema),
  change: z.enum(['better', 'worse', 'same', 'only_one']),
});

export const EvalCompareResponseSchema = z.object({
  jobs: z.array(EvalJobSchema),
  by: z.enum(['task', 'task_agent_model']),
  rows: z.array(EvalCompareRowSchema),
  summary: z.object({
    better: z.number().int(),
    worse: z.number().int(),
    same: z.number().int(),
    only_one: z.number().int(),
  }),
});
export type EvalCompareResponse = z.infer<typeof EvalCompareResponseSchema>;

/** One file of a trial folder: `result.json`, `verifier/test-stdout.txt`, … */
export const EvalTrialFileSchema = z.object({ path: z.string(), size: z.number() });
export const EvalTrialDetailResponseSchema = z.object({
  trial: EvalTrialSchema,
  instruction: z.string().nullable(),
  files: z.array(EvalTrialFileSchema),
});
export type EvalTrialDetailResponse = z.infer<typeof EvalTrialDetailResponseSchema>;

// ── Requests ─────────────────────────────────────────────────────────────────

export const CreateEvalJobRequestSchema = z
  .object({
    /** A suite of `evals:`. Its config is the base; `config` overrides field by field. */
    suite: z.string().min(1).max(120).optional(),
    /**
     * Job config fields, layered over the suite's field by field. Validated as a
     * whole job config after the layering, so a field it leaves out keeps the
     * suite's value, not a default.
     */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Branch or commit the tasks are read at. Default: the default branch. */
    ref: z.string().min(1).max(250).optional(),
    /** Plan only: answer `200` with what would run (`EvalJobPlanResponse`) and create nothing. */
    dry_run: z.boolean().optional(),
  })
  .strict();
export type CreateEvalJobRequest = z.input<typeof CreateEvalJobRequestSchema>;

export const RerunEvalJobRequestSchema = z
  .object({
    /** `failed`: reward below 1 or none. `errored`: ended with an exception. */
    scope: z.enum(['all', 'failed', 'errored']).default('all'),
    /** Only these trials. Wins over `scope`. */
    trial_ids: z.array(z.string()).max(EVAL_LIMITS.max_trials_per_job).optional(),
  })
  .strict();
export type RerunEvalJobRequest = z.input<typeof RerunEvalJobRequestSchema>;

export const EvalErrorSchema = z.object({
  error: z.enum(['eval_not_found', 'eval_invalid', 'eval_conflict', 'eval_forbidden', 'feature_disabled', 'eval_unavailable']),
  message: z.string(),
  violations: z.array(z.string()).optional(),
});
export type EvalError = z.infer<typeof EvalErrorSchema>;
