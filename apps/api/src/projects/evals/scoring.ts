/**
 * Harbor's scoring rules, as pure functions.
 *
 * REWARD: the verifier writes `/logs/verifier/reward.json` (named numbers) or
 * `/logs/verifier/reward.txt` (one number). JSON wins when both exist.
 *
 * ERROR POLICY: each exception type has three independent flags. `should_retry`
 * starts another run of the trial. `should_grade` still runs the verifier.
 * `has_valid_reward` lets the reward count. The groups are Harbor's
 * (`harbor/models/trial/error_policy.py`); a type not listed retries, grades
 * and counts.
 *
 * METRIC: an aggregate over the valid rewards of one agent × model × source.
 * A trial whose reward is invalid is in neither the numerator nor the
 * denominator. A valid trial with no reward counts as 0.
 *
 * PASS@K: Harbor's unbiased estimator, on binary rewards only: every value of
 * every counted reward is 0 or 1, with any number of keys, and a trial passes
 * when all its keys are 1. One 0/1 key is exactly Harbor's rule; several keys
 * are one 0/1 criterion each (a judge). A graded value (strictly between 0
 * and 1) leaves pass@k empty.
 */
import type {
  EvalAgentStats,
  EvalErrorPolicy,
  EvalException,
  EvalJobConfig,
  EvalJobStats,
  EvalMetricConfig,
  EvalRewards,
  EvalTrialStatus,
  EvalUsage,
} from '@kortix/api-contract';

export class EvalTrialError extends Error {
  constructor(
    /** The exception type, in Harbor's names where Harbor has one. */
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

const policy = (should_retry: boolean, should_grade: boolean, has_valid_reward: boolean): EvalErrorPolicy => ({
  should_retry,
  should_grade,
  has_valid_reward,
});

const POLICY_GROUPS: Array<[EvalErrorPolicy, string[]]> = [
  // The agent's own failure: grade what it left, and the reward counts.
  [policy(false, true, true), [
    'NonZeroAgentExitCodeError',
    'AgentTimeoutError',
    'ContextWindowExceededError',
    'OutputTokenExceededError',
    'ContextLengthExceededError',
    'OutputLengthExceededError',
    'AgentSafetyRefusalError',
    'ContentPolicyViolationError',
  ]],
  // The sandbox failed: nothing to grade, run it again.
  [policy(true, false, false), [
    'EnvironmentStartTimeoutError',
    'SandboxBuildFailedError',
    'HealthcheckError',
    'SandboxLikelyOutOfMemoryError',
    'RuntimeRequestError',
    'AddTestsDirError',
    'DownloadVerifierDirError',
    // Kortix: the sandbox stopped under the turn.
    'SandboxGoneError',
  ]],
  // The model API failed: grade for the record, the reward does not count, run it again.
  [policy(true, true, false), [
    'ApiError',
    'ApiRateLimitError',
    'ApiInternalServerError',
    'ApiOverloadedError',
    'ApiConnectionError',
    'ApiUsageLimitError',
    'RateLimitError',
    'InternalServerError',
    'ServiceUnavailableError',
    'UnknownApiError',
    // Kortix: the turn failed with an error no other type names.
    'AgentTurnFailedError',
  ]],
  // A grading failure or a request the model refuses for good: no retry, no valid reward.
  [policy(false, true, false), [
    'BadRequestError',
    'BudgetExceededError',
    'VerifierTimeoutError',
    'RewardFileNotFoundError',
    'RewardFileEmptyError',
    'VerifierOutputParseError',
  ]],
  // Nothing can run: no retry, no grade.
  [policy(false, false, false), [
    'AgentAuthenticationError',
    'ModelNotFoundError',
    'AuthenticationError',
    'PermissionDeniedError',
    'NotFoundError',
    'CancelledError',
    // Kortix: the task cannot run here, the account may not run, or the trial could not be set up.
    'TaskUnsupportedError',
    'TaskLoadError',
    'BillingBlockedError',
    'SessionCreateError',
    'SolutionNotFoundError',
  ]],
];

const POLICY_BY_TYPE = new Map<string, EvalErrorPolicy>(
  POLICY_GROUPS.flatMap(([value, types]) => types.map((type) => [type, value] as const)),
);
const DEFAULT_POLICY = policy(true, true, true);

/** The policy of one exception type, with the job's overrides applied. */
export function errorPolicyFor(type: string, overrides: EvalJobConfig['override_error_policy'] = {}): EvalErrorPolicy {
  return { ...(POLICY_BY_TYPE.get(type) ?? DEFAULT_POLICY), ...(overrides[type] ?? {}) };
}

export function toEvalException(
  err: unknown,
  overrides: EvalJobConfig['override_error_policy'] = {},
  now: Date = new Date(),
): EvalException {
  const type = err instanceof EvalTrialError ? err.type : 'RuntimeRequestError';
  const message = err instanceof Error ? err.message : String(err);
  return {
    exception_type: type,
    exception_message: message.slice(0, 4_000),
    occurred_at: now.toISOString(),
    policy: errorPolicyFor(type, overrides),
  };
}

/** Whether the job runs the trial again after this exception. */
export function shouldRetry(exception: EvalException, retry: EvalJobConfig['retry'], retriesDone: number): boolean {
  if (retriesDone >= retry.max_retries) return false;
  if (retry.exclude_exceptions?.includes(exception.exception_type)) return false;
  if (retry.include_exceptions?.length) return retry.include_exceptions.includes(exception.exception_type);
  return exception.policy.should_retry;
}

/**
 * The error a failed turn names, mapped to an exception type. `name` and
 * `message` are what the session turn ledger recorded (`session_turns.end_error`).
 */
export function turnFailureType(error: { name?: string | null; message?: string | null } | null): string {
  const text = `${error?.name ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (/context (window|length)|too long|maximum context|input is too long/.test(text)) return 'ContextWindowExceededError';
  if (/rate.?limit|429|too many requests/.test(text)) return 'ApiRateLimitError';
  if (/overloaded|529/.test(text)) return 'ApiOverloadedError';
  if (/insufficient credits|payment required|402|budget|out of credits/.test(text)) return 'BudgetExceededError';
  if (/unauthori[sz]ed|401|invalid api key|authentication/.test(text)) return 'AgentAuthenticationError';
  if (/model.*not found|unknown model|no such model/.test(text)) return 'ModelNotFoundError';
  if (/content policy|safety|refus/.test(text)) return 'ContentPolicyViolationError';
  if (/5\d\d|internal server|service unavailable|bad gateway/.test(text)) return 'ApiInternalServerError';
  return 'AgentTurnFailedError';
}

// ── Rewards ──────────────────────────────────────────────────────────────────

/** Parse `reward.json`: an object of named numbers. */
export function parseRewardJson(raw: string): EvalRewards {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EvalTrialError('VerifierOutputParseError', 'reward.json is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EvalTrialError('VerifierOutputParseError', 'reward.json must be an object of named numbers.');
  }
  const rewards: EvalRewards = {};
  for (const [key, value] of Object.entries(parsed)) {
    const number = typeof value === 'boolean' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new EvalTrialError('VerifierOutputParseError', `reward.json: "${key}" is not a number.`);
    }
    rewards[key] = number;
  }
  return rewards;
}

/** Parse `reward.txt`: one number. */
export function parseRewardText(raw: string): EvalRewards {
  const text = raw.trim();
  if (!text) throw new EvalTrialError('RewardFileEmptyError', 'reward.txt is empty.');
  const number = Number(text);
  if (!Number.isFinite(number)) throw new EvalTrialError('VerifierOutputParseError', `reward.txt is not a number: "${text.slice(0, 80)}".`);
  return { reward: number };
}

/** The reward the verifier left. `json` wins over `text`; neither is `RewardFileNotFoundError`. */
export function parseRewards(files: { json: string | null; text: string | null }): EvalRewards {
  if (files.json !== null) return parseRewardJson(files.json);
  if (files.text !== null) return parseRewardText(files.text);
  throw new EvalTrialError('RewardFileNotFoundError', 'The verifier wrote no /logs/verifier/reward.json or /logs/verifier/reward.txt.');
}

// ── Metrics ──────────────────────────────────────────────────────────────────

const AGGREGATE: Record<EvalMetricConfig['type'], (values: number[]) => number> = {
  mean: (values) => values.reduce((a, b) => a + b, 0) / values.length,
  sum: (values) => values.reduce((a, b) => a + b, 0),
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
};

/**
 * One metric over the valid trials' rewards. `null` is a valid trial with no
 * reward: it counts as 0 for every key. With one reward key overall, the value
 * is named after the metric (`{ mean: 0.5 }`); with several, each key
 * aggregates by itself and a trial that lacks a key counts 0 for it.
 */
export function computeMetric(type: EvalMetricConfig['type'], rewards: Array<EvalRewards | null>): Record<string, number> {
  if (rewards.length === 0) return {};
  const keys = [...new Set(rewards.flatMap((reward) => Object.keys(reward ?? {})))];
  if (keys.length <= 1) {
    const key = keys[0];
    return { [type]: AGGREGATE[type](rewards.map((reward) => (key && reward ? (reward[key] ?? 0) : 0))) };
  }
  return Object.fromEntries(keys.map((key) => [key, AGGREGATE[type](rewards.map((reward) => reward?.[key] ?? 0))]));
}

export interface ScoredTrial {
  taskName: string;
  agent: string;
  model: string | null;
  /** The dataset (`name@version`) or task path the task came from. */
  source: string | null;
  attempt: number;
  status: EvalTrialStatus;
  rewards: EvalRewards | null;
  rewardValid: boolean;
  /** The exception type the trial ended with, or null. */
  exceptionType: string | null;
  usage: EvalUsage | null;
  /** A later retry of the same attempt replaced this run: it is in no count. */
  superseded: boolean;
}

/** A trial passes when every reward it has is 1 or more. */
const passed = (rewards: EvalRewards | null): boolean => {
  const values = Object.values(rewards ?? {});
  return values.length > 0 && values.every((value) => value >= 1);
};

/** pass@k counts only binary rewards: every value 0 or 1, any number of keys (no reward counts 0). */
const binary = (rewards: EvalRewards | null): boolean => Object.values(rewards ?? {}).every((value) => value === 0 || value === 1);

/** Harbor's unbiased estimator for one task: `1 − C(n−c, k) / C(n, k)`, as a product. */
export function passAtKEstimate(n: number, c: number, k: number): number {
  if (n - c < k) return 1;
  let miss = 1;
  for (let i = n - c + 1; i <= n; i += 1) miss *= 1 - k / i;
  return 1 - miss;
}

/** k = 1, then Harbor's set: powers of 2 from 2 and multiples of 5, up to `most`. */
export function passAtKValues(most: number): number[] {
  const ks = new Set<number>(most >= 1 ? [1] : []);
  for (let k = 2; k <= most; k *= 2) ks.add(k);
  for (let k = 5; k <= most; k += 5) ks.add(k);
  return [...ks].sort((a, b) => a - b);
}

/**
 * pass@k over the valid trials of one group (Harbor's `utils/pass_at_k.py`):
 * per task, `n` attempts with `c` passes (every key 1), the estimate averaged
 * over tasks, for each k up to the fewest attempts of any task. Empty when a
 * reward holds a graded value.
 */
export function passAtK(trials: ScoredTrial[]): Record<string, number> {
  if (trials.length === 0 || !trials.every((trial) => binary(trial.rewards))) return {};
  const byTask = new Map<string, { n: number; c: number }>();
  for (const trial of trials) {
    const entry = byTask.get(trial.taskName) ?? { n: 0, c: 0 };
    entry.n += 1;
    if (passed(trial.rewards)) entry.c += 1;
    byTask.set(trial.taskName, entry);
  }
  const tasks = [...byTask.values()];
  const fewest = Math.min(...tasks.map((task) => task.n));
  const out: Record<string, number> = {};
  for (const k of passAtKValues(fewest)) {
    out[String(k)] = tasks.reduce((sum, task) => sum + passAtKEstimate(task.n, task.c, k), 0) / tasks.length;
  }
  return out;
}

const addUsage = (total: EvalUsage | null, usage: EvalUsage | null): EvalUsage | null => {
  if (!usage) return total;
  const base = total ?? { n_input_tokens: 0, n_output_tokens: 0, n_cache_tokens: 0, cost_usd: null };
  return {
    n_input_tokens: base.n_input_tokens + usage.n_input_tokens,
    n_output_tokens: base.n_output_tokens + usage.n_output_tokens,
    n_cache_tokens: base.n_cache_tokens + usage.n_cache_tokens,
    cost_usd: usage.cost_usd === null ? base.cost_usd : (base.cost_usd ?? 0) + usage.cost_usd,
  };
};

/**
 * The job's counts and the score of each agent × model × source (Harbor's
 * grouping). `source` is null on every row when the job has one source.
 */
export function computeJobStats(trials: ScoredTrial[], metrics: EvalMetricConfig[]): EvalJobStats {
  const live = trials.filter((trial) => !trial.superseded);
  const count = (statuses: EvalTrialStatus[]) => live.filter((trial) => statuses.includes(trial.status)).length;
  const types = metrics.length ? metrics.map((metric) => metric.type) : (['mean'] as const);
  const several = new Set(live.map((trial) => trial.source ?? '')).size > 1;
  const groups = new Map<string, ScoredTrial[]>();
  for (const trial of live) {
    const key = `${trial.agent}\u0000${trial.model ?? ''}\u0000${several ? (trial.source ?? '') : ''}`;
    groups.set(key, [...(groups.get(key) ?? []), trial]);
  }
  const agents: EvalAgentStats[] = [...groups.values()].map((group) => {
    const valid = group.filter((trial) => trial.rewardValid);
    return {
      agent: group[0]!.agent,
      model: group[0]!.model,
      source: several ? group[0]!.source : null,
      n_trials: valid.length,
      n_errors: group.filter((trial) => trial.exceptionType !== null).length,
      metrics: types.map((type) => computeMetric(type, valid.map((trial) => trial.rewards))),
      pass_at_k: passAtK(valid),
    };
  });
  const exceptionStats: Record<string, number> = {};
  for (const trial of live) if (trial.exceptionType) exceptionStats[trial.exceptionType] = (exceptionStats[trial.exceptionType] ?? 0) + 1;
  return {
    n_total_trials: live.length,
    n_queued: count(['queued']),
    n_running: count(['starting', 'agent_running', 'verifying']),
    n_completed: count(['completed']),
    n_errored: count(['errored']),
    n_cancelled: count(['cancelled']),
    n_retries: trials.length - live.length,
    exception_stats: exceptionStats,
    usage: trials.reduce<EvalUsage | null>((total, trial) => addUsage(total, trial.usage), null),
    agents,
  };
}
