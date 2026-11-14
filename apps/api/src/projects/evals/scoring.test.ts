import { describe, expect, test } from 'bun:test';
import { EvalJobConfigSchema } from '@kortix/api-contract';
import { planTrials } from './config';
import { cleanInstruction, dockerfileWorkdir, parseHarborTask, taskNameMatches } from './harbor-task';
import { EvalTrialError, computeJobStats, computeMetric, errorPolicyFor, parseRewards, passAtKEstimate, passAtKValues, shouldRetry, toEvalException, turnFailureType, type ScoredTrial } from './scoring';

const trial = (over: Partial<ScoredTrial>): ScoredTrial => ({
  taskName: 't1',
  agent: 'a',
  model: null,
  source: null,
  attempt: 1,
  status: 'completed',
  rewards: { reward: 1 },
  rewardValid: true,
  exceptionType: null,
  usage: null,
  superseded: false,
  ...over,
});

describe('rewards', () => {
  test('reward.json wins over reward.txt', () => {
    expect(parseRewards({ json: '{"correctness": 1, "style": 0.5}', text: '0' })).toEqual({ correctness: 1, style: 0.5 });
  });
  test('reward.txt is one number named reward', () => {
    expect(parseRewards({ json: null, text: ' 1\n' })).toEqual({ reward: 1 });
  });
  test('no file, an empty file and a non-number are three different errors', () => {
    const typeOf = (run: () => unknown) => {
      try {
        run();
      } catch (err) {
        return (err as EvalTrialError).type;
      }
      return null;
    };
    expect(typeOf(() => parseRewards({ json: null, text: null }))).toBe('RewardFileNotFoundError');
    expect(typeOf(() => parseRewards({ json: null, text: '  ' }))).toBe('RewardFileEmptyError');
    expect(typeOf(() => parseRewards({ json: null, text: 'pass' }))).toBe('VerifierOutputParseError');
    expect(typeOf(() => parseRewards({ json: '{"a": "x"}', text: null }))).toBe('VerifierOutputParseError');
    expect(typeOf(() => parseRewards({ json: '[1]', text: null }))).toBe('VerifierOutputParseError');
  });
});

describe('error policy', () => {
  test('an agent timeout is graded and its reward counts, with no retry', () => {
    expect(errorPolicyFor('AgentTimeoutError')).toEqual({ should_retry: false, should_grade: true, has_valid_reward: true });
  });
  test('a sandbox failure retries and is never scored', () => {
    expect(errorPolicyFor('EnvironmentStartTimeoutError')).toEqual({ should_retry: true, should_grade: false, has_valid_reward: false });
  });
  test('a model API failure is graded for the record but does not count', () => {
    expect(errorPolicyFor('ApiRateLimitError')).toEqual({ should_retry: true, should_grade: true, has_valid_reward: false });
  });
  test('a job override replaces single flags', () => {
    expect(errorPolicyFor('AgentTimeoutError', { AgentTimeoutError: { should_retry: true } })).toEqual({ should_retry: true, should_grade: true, has_valid_reward: true });
  });
  test('retries stop at max_retries, and exclusions win over inclusions', () => {
    const exception = toEvalException(new EvalTrialError('ApiRateLimitError', 'x'));
    expect(shouldRetry(exception, { max_retries: 0 }, 0)).toBe(false);
    expect(shouldRetry(exception, { max_retries: 2 }, 1)).toBe(true);
    expect(shouldRetry(exception, { max_retries: 2 }, 2)).toBe(false);
    expect(shouldRetry(exception, { max_retries: 2, include_exceptions: ['ApiRateLimitError'], exclude_exceptions: ['ApiRateLimitError'] }, 0)).toBe(false);
    expect(shouldRetry(exception, { max_retries: 2, include_exceptions: ['Other'] }, 0)).toBe(false);
  });
  test('a turn error maps to its exception type', () => {
    expect(turnFailureType({ name: 'APIError', message: 'Input is too long for requested model' })).toBe('ContextWindowExceededError');
    expect(turnFailureType({ name: null, message: '429 Too Many Requests' })).toBe('ApiRateLimitError');
    expect(turnFailureType({ name: null, message: 'Payment Required: Insufficient credits.' })).toBe('BudgetExceededError');
    expect(turnFailureType(null)).toBe('AgentTurnFailedError');
  });
});

describe('metrics', () => {
  test('one reward key is named after the metric; a missing reward counts 0', () => {
    expect(computeMetric('mean', [{ reward: 1 }, { reward: 0 }, null, { reward: 0 }])).toEqual({ mean: 0.25 });
  });
  test('several keys aggregate each by itself; a missing key counts 0', () => {
    expect(computeMetric('mean', [{ correctness: 1 }, { style: 1 }, {}, null])).toEqual({ correctness: 0.25, style: 0.25 });
  });
  test('sum, min and max', () => {
    const rewards = [{ reward: 1 }, { reward: 0.5 }];
    expect(computeMetric('sum', rewards)).toEqual({ sum: 1.5 });
    expect(computeMetric('min', rewards)).toEqual({ min: 0.5 });
    expect(computeMetric('max', rewards)).toEqual({ max: 1 });
  });
  test('an invalid reward is in neither the numerator nor the denominator', () => {
    const stats = computeJobStats(
      [trial({ taskName: 'a', rewards: { reward: 0 } }), trial({ taskName: 'b', rewards: { reward: 1 } }), trial({ taskName: 'c', rewards: { reward: 1 }, rewardValid: false, exceptionType: 'AgentTimeoutError', status: 'errored' })],
      [],
    );
    expect(stats.agents[0]!.metrics).toEqual([{ mean: 0.5 }]);
    expect(stats.agents[0]!.n_trials).toBe(2);
    expect(stats.agents[0]!.n_errors).toBe(1);
    expect(stats.n_errored).toBe(1);
  });
  test('a superseded run is in no count; agents and models score apart', () => {
    const stats = computeJobStats(
      [
        trial({ rewards: null, rewardValid: false, exceptionType: 'AgentTimeoutError', status: 'errored', superseded: true }),
        trial({ rewards: { reward: 1 } }),
        trial({ agent: 'b', model: 'p/m', rewards: { reward: 0 } }),
      ],
      [{ type: 'mean' }, { type: 'max' }],
    );
    expect(stats.n_total_trials).toBe(2);
    expect(stats.agents.map((a) => [a.agent, a.model, a.metrics])).toEqual([
      ['a', null, [{ mean: 1 }, { max: 1 }]],
      ['b', 'p/m', [{ mean: 0 }, { max: 0 }]],
    ]);
  });
  test('pass@k is Harbor\'s unbiased estimator, averaged over tasks', () => {
    const stats = computeJobStats(
      [
        trial({ taskName: 'a', attempt: 1, rewards: { reward: 0 } }),
        trial({ taskName: 'a', attempt: 2, rewards: { reward: 1 } }),
        trial({ taskName: 'b', attempt: 1, rewards: { reward: 0 } }),
        trial({ taskName: 'b', attempt: 2, rewards: { reward: 0 } }),
      ],
      [],
    );
    // a: n=2, c=1 → pass@1 = 0.5, pass@2 = 1. b: c=0 → 0. Mean over tasks.
    expect(stats.agents[0]!.pass_at_k).toEqual({ '1': 0.25, '2': 0.5 });
  });
  test('the estimator matches 1 − C(n−c, k) / C(n, k)', () => {
    const choose = (n: number, k: number): number => (k > n ? 0 : k === 0 ? 1 : (n / k) * choose(n - 1, k - 1));
    for (const [n, c, k] of [[10, 3, 1], [10, 3, 5], [8, 0, 4], [8, 8, 2], [5, 2, 4]] as const) {
      expect(passAtKEstimate(n, c, k)).toBeCloseTo(1 - choose(n - c, k) / choose(n, k), 12);
    }
  });
  test('k is 1, then powers of 2 and multiples of 5, up to the fewest attempts', () => {
    expect(passAtKValues(1)).toEqual([1]);
    expect(passAtKValues(16)).toEqual([1, 2, 4, 5, 8, 10, 15, 16]);
    const uneven = computeJobStats([trial({ taskName: 'a', attempt: 1 }), trial({ taskName: 'a', attempt: 2 }), trial({ taskName: 'b', attempt: 1 })], []);
    expect(Object.keys(uneven.agents[0]!.pass_at_k)).toEqual(['1']);
  });
  test('several 0/1 keys are binary: a trial passes when every key is 1', () => {
    const stats = computeJobStats(
      [trial({ taskName: 'a', rewards: { asks: 1, channel: 1 } }), trial({ taskName: 'b', rewards: { asks: 1, channel: 0 } }), trial({ taskName: 'c', rewards: { reward: 1 } })],
      [],
    );
    expect(stats.agents[0]!.pass_at_k).toEqual({ '1': 2 / 3 });
  });
  test('a graded value leaves pass@k empty; the metric still scores it', () => {
    const stats = computeJobStats([trial({ rewards: { reward: 0.75 } }), trial({ taskName: 't2', rewards: { exists: 1, correct: 0 } })], []);
    expect(stats.agents[0]!.pass_at_k).toEqual({});
    expect(stats.agents[0]!.metrics[0]).toEqual({ reward: 0.375, exists: 0.5, correct: 0 });
  });
  test('two sources score apart; retries, exception types and usage add up', () => {
    const usage = { n_input_tokens: 10, n_output_tokens: 2, n_cache_tokens: 1, cost_usd: 0.5 };
    const stats = computeJobStats(
      [
        trial({ source: 'kortix/my-kortix@dev', usage }),
        trial({ source: 'terminal-bench@2.0', rewards: { reward: 0 }, usage: { ...usage, cost_usd: null } }),
        trial({ source: 'terminal-bench@2.0', taskName: 't2', status: 'errored', rewards: null, rewardValid: false, exceptionType: 'ApiRateLimitError', superseded: true }),
        trial({ source: 'terminal-bench@2.0', taskName: 't2', status: 'errored', exceptionType: 'AgentTimeoutError', rewards: { reward: 0 } }),
      ],
      [],
    );
    expect(stats.agents.map((a) => [a.source, a.n_trials])).toEqual([['kortix/my-kortix@dev', 1], ['terminal-bench@2.0', 2]]);
    expect([stats.n_total_trials, stats.n_retries, stats.exception_stats]).toEqual([3, 1, { AgentTimeoutError: 1 }]);
    expect(stats.usage).toEqual({ n_input_tokens: 20, n_output_tokens: 4, n_cache_tokens: 2, cost_usd: 0.5 });
    expect(computeJobStats([trial({ source: 'x' })], []).agents[0]!.source).toBeNull();
  });
});

describe('harbor task', () => {
  const base = { folderName: 'hello', instruction: '<!-- canary GUID -->\n\nCreate /app/hello.txt\n', dockerfile: 'FROM ubuntu:24.04\nWORKDIR /app\nWORKDIR site\n', paths: ['task.toml', 'instruction.md', 'tests/test.sh', 'solution/solve.sh', 'environment/Dockerfile'] };
  test('reads timeouts, the image, sizes and the working directory', () => {
    const task = parseHarborTask({ ...base, taskToml: '[agent]\ntimeout_sec = 900.0\n[verifier]\ntimeout_sec = 120\n[environment]\ndocker_image = "org/img:1"\ncpus = 1\nmemory = "2G"\nstorage_mb = 10240\n[metadata]\ndifficulty = "easy"\n' });
    expect(task).toMatchObject({ name: 'hello', instruction: 'Create /app/hello.txt', agentTimeoutSec: 900, verifierTimeoutSec: 120, dockerImage: 'org/img:1', cpus: 1, memoryMb: 2048, storageMb: 10240, workdir: '/app/site', hasSolution: true, unsupported: null });
    expect(task.metadata).toEqual({ difficulty: 'easy' });
  });
  test('defaults when task.toml names nothing', () => {
    expect(parseHarborTask({ ...base, taskToml: '', dockerfile: null, paths: ['task.toml', 'instruction.md', 'tests/test.sh'] })).toMatchObject({ agentTimeoutSec: 1800, verifierTimeoutSec: 600, dockerImage: null, workdir: null, hasSolution: false });
  });
  test('a folder without instruction.md or tests/test.sh is not a task', () => {
    expect(() => parseHarborTask({ ...base, taskToml: '', instruction: null })).toThrow('no instruction.md');
    expect(() => parseHarborTask({ ...base, taskToml: '', paths: ['task.toml', 'instruction.md'] })).toThrow('no tests/test.sh');
    expect(() => parseHarborTask({ ...base, taskToml: null })).toThrow('no task.toml');
  });
  test('what Kortix cannot run is named', () => {
    expect(parseHarborTask({ ...base, taskToml: '[verifier]\nenvironment_mode = "separate"\n' }).unsupported).toContain('separate verifier');
    expect(parseHarborTask({ ...base, taskToml: '[environment]\nos = "windows"\n' }).unsupported).toContain('Windows');
    expect(parseHarborTask({ ...base, taskToml: '', paths: [...base.paths, 'environment/docker-compose.yaml'] }).unsupported).toContain('Multi-container');
  });
  test('helpers', () => {
    expect(cleanInstruction('<!-- a -->\n<!-- b -->\nDo it. <!-- kept -->')).toBe('Do it. <!-- kept -->');
    expect(dockerfileWorkdir('FROM x\nRUN true')).toBeNull();
    expect(taskNameMatches('fix-git', 'fix-*')).toBe(true);
    expect(taskNameMatches('fix-git', 'git')).toBe(false);
  });
});

describe('trial plan', () => {
  const task = (name: string) => ({ name, ref: { kind: 'repo' as const, path: `evals/${name}` }, task: {} as never });
  test('tasks × agents × attempts, with unique folder-safe names', () => {
    const config = EvalJobConfigSchema.parse({ n_attempts: 2, agents: [{ name: 'oracle' }, { name: 'coder', model_name: 'p/m1' }, { name: 'coder', model_name: 'p/m2' }], tasks: [{ path: 'evals' }] });
    const trials = planTrials(config, [task('a'), task('B c')]);
    expect(trials.length).toBe(12);
    expect(new Set(trials.map((t) => t.trialName)).size).toBe(12);
    expect(trials.filter((t) => t.agent === 'oracle').every((t) => t.model === null)).toBe(true);
    expect(trials.map((t) => t.trialName)).toContain('b-c__coder-p-m2__2');
    expect(trials.every((t) => /^[a-z0-9._-]+$/.test(t.trialName))).toBe(true);
  });
  test('over the trial limit is refused', () => {
    const config = EvalJobConfigSchema.parse({ n_attempts: 100, tasks: [{ path: 'evals' }] });
    expect(() => planTrials(config, Array.from({ length: 21 }, (_, i) => task(`t${i}`)))).toThrow('The limit is 2000');
  });
});

describe('provider rate limits', () => {
  test('a 429 with retry-after waits that long; any other error is not a rate limit', async () => {
    const { rateLimitWaitMs } = await import('./box');
    const wait = rateLimitWaitMs('platinum POST /v1/sandboxes/x/exec -> 429 {"code":"rate_limited"} retry-after=2');
    expect(wait).toBeGreaterThanOrEqual(2000);
    expect(wait).toBeLessThan(2500);
    expect(rateLimitWaitMs('exec -> 500 internal')).toBeNull();
  });
});
