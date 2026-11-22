import { gatewayRequestLogs as logs } from '@kortix/db';
import { sql } from 'drizzle-orm';

// USD / million tokens, models.dev snapshot retrieved 2026-11-20.
// Morph uses the upstream deepseek-v4.1-flash-1017 retail proxy, not its bill.
export const LLM_VALUE_VERSION = 'models.dev:2026-11-20:v2';
export const LLM_VALUE_COVERAGE =
  'LLM retail value, not a bill. Exact Sol/Terra and Claude 5.5 Opus/Sonnet pricing; Morph uses DeepSeek v4.1 Flash 1017 proxy pricing. Other models unknown. Compute/browser and subscription fees excluded.';
const sol = { input: 2, output: 10, cached: 0.1, write: 2.5 };
const terra = { input: 1, output: 5, cached: 0.05, write: 1.25 };
const prices = [
  { providers: ['openai', 'openai-codex'], model: 'gpt-6.1-sol', base: sol, long: { input: 4, output: 15, cached: 0.2, write: 5 } },
  { providers: ['openai', 'openai-codex'], model: 'gpt-6.1-terra', base: terra, long: { input: 2, output: 7.5, cached: 0.1, write: 2.5 } },
  { providers: ['morph_abliterated'], model: 'morph-dsv41flash-abliterated', base: { input: 0.3, output: 1.2, cached: 0.006, write: 0.3 } },
  { providers: ['anthropic', 'claude-agent'], model: 'claude-opus-5-5', base: { input: 4, output: 20, cached: 0.2, write: 5 } },
  { providers: ['anthropic', 'claude-agent'], model: 'claude-sonnet-5-5', base: sol },
];

export function estimateLlmValue(row: {
  provider: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}): number | null {
  const price = prices.find((p) => p.providers.includes(row.provider) && p.model === row.model);
  if (!price) return null;
  if (
    ![row.input, row.output, row.cached, row.cacheWrite].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    row.cached + row.cacheWrite > row.input
  )
    return null;
  const r = row.input > 272000 && price.long ? price.long : price.base;
  return (
    ((row.input - row.cached - row.cacheWrite) * r.input +
      row.cached * r.cached +
      row.cacheWrite * r.write +
      row.output * r.output) /
    1_000_000
  );
}

// Same rate snapshot in SQL so all reporting aggregates the same request-level
// values, never repricing a window's token sum across a context-price boundary.
// KRTX-4023: the usage-was-estimated gate reads the promoted `usage_estimated`
// column (real column, written by the gateway writer + the 20261108090000200
// backfill), not `metadata->>'usageEstimated'` — a jsonb expression cannot
// join the covering indexes' INCLUDE lists, so reading metadata here
// heap-fetches every aggregated row and the dashboard polls cross the 25 s
// statement timeout as 5xx. NULL (rows written before the promotion) reads as
// not-estimated, exactly as a missing metadata key does.
const rate = (base: number, long: number | undefined) => long === undefined
  ? sql`${base}::numeric`
  : sql`case when ${logs.inputTokens} > 272000 then ${long}::numeric else ${base}::numeric end`;
const modelValues = prices.map((p) => sql`when ${logs.provider} in (${sql.join(p.providers.map((provider) => sql`${provider}`), sql`, `)}) and ${logs.resolvedModel} = ${p.model}
  then ((${logs.inputTokens} - ${logs.cachedTokens} - ${logs.cacheWriteTokens}) * ${rate(p.base.input, p.long?.input)}
    + ${logs.cachedTokens} * ${rate(p.base.cached, p.long?.cached)}
    + ${logs.cacheWriteTokens} * ${rate(p.base.write, p.long?.write)}
    + ${logs.outputTokens} * ${rate(p.base.output, p.long?.output)}) / 1000000`);
export const rowLlmValueSql = sql<number | null>`case when
  ${logs.ok} and not coalesce(${logs.usageEstimated}, false)
  and ${logs.inputTokens} >= 0 and ${logs.outputTokens} >= 0
  and ${logs.cachedTokens} >= 0 and ${logs.cacheWriteTokens} >= 0
  and ${logs.cachedTokens} + ${logs.cacheWriteTokens} <= ${logs.inputTokens}
  then case ${sql.join(modelValues, sql` `)} end end`;

export const llmValueFields = {
  estimated_usage_value: sql<number | null>`sum(${rowLlmValueSql})::float8`,
  priced_requests: sql<number>`count(${rowLlmValueSql})::int`,
  unpriced_requests: sql<number>`count(*) filter (where ${logs.ok} and ${rowLlmValueSql} is null)::int`,
};
export const llmValueBasis = {
  rate_version: LLM_VALUE_VERSION,
  rate_source: 'https://models.dev/api.json',
  coverage: LLM_VALUE_COVERAGE,
  subscription_fee: null,
  subscription_allocation: null,
};
