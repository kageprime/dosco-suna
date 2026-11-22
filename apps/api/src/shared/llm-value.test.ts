import { expect, test } from 'bun:test';
import { estimateLlmValue } from './llm-value';

const call = {
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  input: 1000,
  output: 100,
  cached: 500,
  cacheWrite: 0,
};
test('subscription usage value is not a charge and cache reads replace plain input', () => {
  expect(estimateLlmValue(call)).toBeCloseTo(0.00205, 10);
});
test('unknown pricing and malformed cache counts stay unknown', () => {
  expect(estimateLlmValue({ ...call, model: 'unknown' })).toBeNull();
  expect(estimateLlmValue({ ...call, cached: 1001 })).toBeNull();
});
test('cache writes replace plain input and use their own rate', () => {
  expect(estimateLlmValue({ ...call, cached: 0, cacheWrite: 500 })).toBeCloseTo(0.00325, 10);
});
test('long context uses documented higher rates', () => {
  expect(estimateLlmValue({ ...call, input: 300000, cached: 0 })).toBeCloseTo(1.2015, 10);
});
test('request estimates reconcile when grouped without adding charges', () => {
  const a = estimateLlmValue(call);
  const b = estimateLlmValue({ ...call, output: 200 });
  if (a === null || b === null) throw new Error('Known rates must be priced');
  expect(a + b).toBeCloseTo(0.0051, 10);
});
test.each([
  ['openai-codex', 'gpt-6.1-terra', 0.001025],
  ['morph_abliterated', 'morph-dsv41flash-abliterated', 0.000273],
  ['claude-agent', 'claude-opus-5-5', 0.0041],
  ['claude-agent', 'claude-sonnet-5-5', 0.00205],
])('prices %s/%s independently of charges', (provider, model, expected) => {
  expect(estimateLlmValue({ ...call, provider, model })).toBeCloseTo(expected, 10);
});

test('context threshold and provider identity stay exact', () => {
  expect(estimateLlmValue({ ...call, model: 'gpt-6.1-terra', input: 272000, output: 0, cached: 0 })).toBe(0.272);
  expect(estimateLlmValue({ ...call, model: 'gpt-6.1-terra', input: 272001, output: 0, cached: 0 })).toBe(0.544002);
  expect(estimateLlmValue({ ...call, provider: 'unrecognized' })).toBeNull();
  expect(estimateLlmValue({ ...call, input: -1 })).toBeNull();
  expect(estimateLlmValue({ ...call, output: NaN })).toBeNull();
  expect(estimateLlmValue({ ...call, cacheWrite: 501 })).toBeNull();
});
