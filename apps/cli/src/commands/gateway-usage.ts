/**
 * `kortix gateway usage --group-by …` — the cross-session, full-history spend
 * and token query. A thin client over `GET /workspaces/:id/gateway/usage`: the
 * server aggregates every matching ledger row (no cap) and keyset-paginates the
 * returned GROUPS; this renders them, and with `--all` follows `next_cursor`
 * until the fixed window is drained.
 *
 * Honesty: paid Kortix wallet spend, BYOK provider spend and the total are
 * printed as three separate, labelled numbers, and the list-price usage
 * ESTIMATE is kept apart from spend (never called "paid"). The raw JSON
 * (`--json`) carries the exact USD floats.
 */
import {
  emitJson,
  fail,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, money, pad } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const DIMENSIONS = ['model', 'agent', 'source', 'session', 'day'] as const;
type Dimension = (typeof DIMENSIONS)[number];

interface UsageGroup {
  model?: string;
  agent?: string;
  source?: string;
  session?: string | null;
  day?: string;
  kortix_cost: number;
  provider_cost: number;
  total_cost: number;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  estimated_usage_value: number | null;
  priced_requests: number;
  unpriced_requests: number;
  last_at: string | null;
}

interface UsageResult {
  group_by: Dimension[];
  window: { since: string | null; until: string | null; days: number | null };
  valuation: { coverage?: string } & Record<string, unknown>;
  groups: UsageGroup[];
  totals: Omit<UsageGroup, 'model' | 'agent' | 'source' | 'session' | 'day' | 'last_at'> & {
    groups: number;
  };
  next_cursor: string | null;
}

const num = (n: number) => Number(n ?? 0).toLocaleString('en-US');

export async function gatewayUsageQuery(
  rest: string[],
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  let since: string | undefined;
  let until: string | undefined;
  let days: string | undefined;
  let groupByRaw: string | undefined;
  let limit: string | undefined;
  let cursor: string | undefined;
  const all = takeFlagBool(rest, ['--all']);
  try {
    since = takeFlagValue(rest, ['--since']);
    until = takeFlagValue(rest, ['--until']);
    days = takeFlagValue(rest, ['--days']);
    groupByRaw = takeFlagValue(rest, ['--group-by', '--group']);
    limit = takeFlagValue(rest, ['--limit']);
    cursor = takeFlagValue(rest, ['--cursor']);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (all && cursor) return fail('--all drains from the start; do not combine it with --cursor');

  const groupBy = (groupByRaw ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const baseParams = new URLSearchParams();
  if (since) baseParams.set('since', since);
  if (until) baseParams.set('until', until);
  if (days) baseParams.set('days', days);
  if (groupBy.length) baseParams.set('group_by', groupBy.join(','));
  if (limit) baseParams.set('limit', limit);

  const fetchPage = (cur?: string): Promise<UsageResult> => {
    const params = new URLSearchParams(baseParams);
    if (cur) params.set('cursor', cur);
    return ctx.client.get<UsageResult>(
      `/workspaces/${ctx.projectId}/gateway/usage?${params.toString()}`,
    );
  };

  let result: UsageResult;
  try {
    result = await fetchPage(cursor);
  } catch (err) {
    return surfaceApiError(err);
  }

  if (all && result.next_cursor) {
    // Drain the window. Page 1 may have used a rolling `--days`/`--since`
    // window; from here on we page against the ABSOLUTE bounds the server
    // resolved and echoed (result.window), so every page scans the identical
    // window and the keyset order cannot shift under us. We also refuse a
    // repeating cursor (a server bug) instead of looping or silently cutting
    // the drain short.
    const frozen = new URLSearchParams();
    if (result.window.since) frozen.set('since', result.window.since);
    if (result.window.until) frozen.set('until', result.window.until);
    if (groupBy.length) frozen.set('group_by', groupBy.join(','));
    if (limit) frozen.set('limit', limit);
    const seen = new Set<string>();
    let next: string | null = result.next_cursor;
    try {
      while (next) {
        if (seen.has(next)) {
          return fail(
            'gateway returned a repeating cursor; aborting the drain so partial data is never reported as complete (server bug)',
          );
        }
        seen.add(next);
        const params = new URLSearchParams(frozen);
        params.set('cursor', next);
        const more: UsageResult = await ctx.client.get<UsageResult>(
          `/workspaces/${ctx.projectId}/gateway/usage?${params.toString()}`,
        );
        result.groups.push(...more.groups);
        next = more.next_cursor;
      }
    } catch (err) {
      return surfaceApiError(err);
    }
    result.next_cursor = null;
  }

  if (json) {
    emitJson(result);
    return 0;
  }

  renderUsage(result);
  return 0;
}

function windowLabel(w: UsageResult['window']): string {
  if (w.since || w.until) return `${w.since ?? '…'} → ${w.until ?? 'now'}`;
  return `LAST ${w.days}d`;
}

function renderUsage(result: UsageResult): void {
  const t = result.totals;
  const out: string[] = [];
  out.push(
    `\n  ${C.dim}${windowLabel(result.window)}${C.reset}  ` +
      `${num(t.requests)} req · ${num(t.errors)} err · ${num(t.groups)} group${t.groups === 1 ? '' : 's'}`,
  );
  // The three money concepts, never blended.
  out.push(
    `  PAID WALLET ${money(t.kortix_cost)}  ·  BYOK PROVIDER ${money(t.provider_cost)}  ·  TOTAL ${money(t.total_cost)}`,
  );
  out.push(
    `  ${C.dim}tokens in/out/cached/write: ${num(t.input_tokens)}/${num(t.output_tokens)}/${num(t.cached_tokens)}/${num(t.cache_write_tokens)}${C.reset}`,
  );
  out.push(
    `  ${C.dim}LLM estimated usage value (not a bill): ${t.estimated_usage_value == null ? 'unknown' : money(t.estimated_usage_value)} · priced ${num(t.priced_requests)}; unpriced ${num(t.unpriced_requests)}${C.reset}`,
  );
  if (result.valuation?.coverage) out.push(`  ${C.dim}${result.valuation.coverage}${C.reset}`);

  const dims = result.group_by;
  if (dims.length && result.groups.length) {
    out.push(`\n  ${C.dim}BY ${dims.join(', ').toUpperCase()}${C.reset}`);
    const dimWidth = (d: Dimension) => (d === 'session' ? 40 : d === 'day' ? 10 : 26);
    for (const g of result.groups) {
      const keys = dims.map((d) => pad(String(dimValue(g, d) ?? 'unknown'), dimWidth(d))).join(' ');
      out.push(
        `  ${keys}  ${money(g.total_cost).padStart(10)}  ` +
          `${C.dim}paid ${money(g.kortix_cost)} · byok ${money(g.provider_cost)} · ${num(g.requests)} req · ${num(g.input_tokens + g.output_tokens)} tok${C.reset}`,
      );
    }
  }
  if (result.next_cursor) {
    out.push(
      `\n  ${C.dim}more groups — next page:${C.reset} --cursor ${result.next_cursor}  ${C.dim}(or --all)${C.reset}`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n\n`);
}

function dimValue(g: UsageGroup, d: Dimension): string | null | undefined {
  return g[d];
}
