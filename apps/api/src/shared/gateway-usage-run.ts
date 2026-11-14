import { gatewayRequestLogs, projectSessions } from '@kortix/db';
/**
 * Live execution of `GET /{workspaceId}/gateway/usage` — the cross-session,
 * full-history spend and token query over `gateway_request_logs`.
 *
 * SQL aggregates run over EVERY matching ledger row (no row ceiling): the
 * GROUP BY reduces the scan to one row per group server-side. The returned
 * GROUPS are keyset-paginated (ordered by total spend desc, with a
 * deterministic tiebreak), so a dimension with more groups than any single
 * page — e.g. group-by session across all history — drains fully by following
 * `next_cursor`, never truncated at a fixed count.
 *
 * Money honesty is inherited from shared/llm-spend.ts (the ONE definition of
 * paid wallet vs BYOK provider vs total) and shared/llm-value.ts (the
 * list-price usage ESTIMATE, kept apart from spend). This module never adds a
 * fourth rule.
 */
import type { SQL } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isoValue, numberValue } from './cost-values';
import { db } from './db';
import {
  type GatewayUsageQuery,
  SORT_KEY_SEP,
  type UsageDimension,
  encodeUsageCursor,
} from './gateway-usage-query';
import { kortixBilledSpendSql, providerBilledSpendSql, totalSpendSql } from './llm-spend';
import { llmValueBasis, llmValueFields } from './llm-value';
import { servedModelSql } from './served-model';

const logs = gatewayRequestLogs;

/** Caller's row visibility, applied only when the query exposes session ids. */
export interface GatewayUsageVisibility {
  /** `projectReadView.where(sessionColumn)` — undefined for a full-access caller. */
  sessionFilter: SQL | undefined;
}

export interface GatewayUsageGroup {
  /** The selected dimension values, present only for selected dimensions. */
  model?: string;
  agent?: string;
  source?: string;
  session?: string | null;
  day?: string;
  /** Paid Kortix wallet spend (USD). */
  kortix_cost: number;
  /** BYOK spend paid straight to your own provider (USD). */
  provider_cost: number;
  /** kortix_cost + provider_cost (USD). */
  total_cost: number;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  /** List-price usage ESTIMATE (not a bill); null when no row was priceable. */
  estimated_usage_value: number | null;
  priced_requests: number;
  unpriced_requests: number;
  last_at: string | null;
}

export interface GatewayUsageTotals
  extends Omit<GatewayUsageGroup, 'model' | 'agent' | 'source' | 'session' | 'day' | 'last_at'> {
  /** Distinct group count across the whole window (independent of paging). */
  groups: number;
}

export interface GatewayUsageResult {
  group_by: UsageDimension[];
  window: { since: string | null; until: string | null; days: number | null };
  /** How spend/value is labelled — carried verbatim so no caller re-prices. */
  valuation: typeof llmValueBasis;
  groups: GatewayUsageGroup[];
  /** Grand total across the whole window, independent of group pagination. */
  totals: GatewayUsageTotals;
  /** Follow this for the next page of GROUPS; null when the last page is reached. */
  next_cursor: string | null;
}

type AggregateRow = {
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
  last_at: Date | string | null;
};

const EMPTY_AGGREGATE: AggregateRow = {
  kortix_cost: 0,
  provider_cost: 0,
  total_cost: 0,
  requests: 0,
  errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  estimated_usage_value: null,
  priced_requests: 0,
  unpriced_requests: 0,
  last_at: null,
};

const aggregateSelection = {
  kortix_cost: kortixBilledSpendSql,
  provider_cost: providerBilledSpendSql,
  total_cost: totalSpendSql,
  requests: sql<number>`count(*)::int`,
  errors: sql<number>`count(*) filter (where not ${logs.ok})::int`,
  input_tokens: sql<number>`coalesce(sum(${logs.inputTokens}), 0)::float8`,
  output_tokens: sql<number>`coalesce(sum(${logs.outputTokens}), 0)::float8`,
  cached_tokens: sql<number>`coalesce(sum(${logs.cachedTokens}), 0)::float8`,
  cache_write_tokens: sql<number>`coalesce(sum(${logs.cacheWriteTokens}), 0)::float8`,
  ...llmValueFields,
  last_at: sql<Date | null>`max(${logs.createdAt})`,
};

function mapAggregate(row: AggregateRow) {
  return {
    kortix_cost: numberValue(row.kortix_cost),
    provider_cost: numberValue(row.provider_cost),
    total_cost: numberValue(row.total_cost),
    requests: numberValue(row.requests),
    errors: numberValue(row.errors),
    input_tokens: numberValue(row.input_tokens),
    output_tokens: numberValue(row.output_tokens),
    cached_tokens: numberValue(row.cached_tokens),
    cache_write_tokens: numberValue(row.cache_write_tokens),
    estimated_usage_value:
      row.estimated_usage_value == null ? null : numberValue(row.estimated_usage_value),
    priced_requests: numberValue(row.priced_requests),
    unpriced_requests: numberValue(row.unpriced_requests),
  };
}

/** The SQL expression that produces each dimension's group key (all text). */
function dimensionExpr(dimension: UsageDimension, parent: ReturnType<typeof alias>): SQL<string> {
  switch (dimension) {
    case 'model':
      return servedModelSql;
    case 'agent':
      return sql<string>`coalesce(${projectSessions.agentName}, 'unknown')`;
    case 'source':
      // SECOND COPY of the source-label rule in shared/session-costs.ts
      // listProjectGatewaySourceSpend: the trigger slug that started the
      // session (or its parent), else the initiator type, else 'unattributed'
      // for a sessionless row, else 'unknown'. A presentation label, not money
      // math, so it is duplicated with this pointer rather than forced through
      // one factory across unlike query shapes.
      return sql<string>`coalesce(
        case when ${projectSessions.initiatorType} = 'trigger' then ${projectSessions.initiatorId} end,
        case when ${parent.initiatorType} = 'trigger' then ${parent.initiatorId} end,
        ${projectSessions.initiatorType}::text,
        case when ${logs.sessionId} is null then 'unattributed' end,
        'unknown'
      )`;
    case 'session':
      return sql<string>`${logs.sessionId}`;
    case 'day':
      return sql<string>`to_char((${logs.createdAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`;
  }
}

/** Only `agent`/`source` need the session join; `session`/`model`/`day` read logs directly. */
function needsSessionJoin(groupBy: UsageDimension[]): boolean {
  return groupBy.includes('agent') || groupBy.includes('source');
}

/**
 * Resolve the query's window to ABSOLUTE bounds, evaluated once per call.
 *
 * A rolling `days` window is pinned to `[now - days, now]` here, not left as a
 * SQL `now()` the database re-evaluates — so when a caller pages a drain, it
 * reads these resolved bounds from the response and passes them back verbatim,
 * and every page scans the identical window. A SQL `now()` per page would let
 * rows age past the lower bound mid-drain and shift group costs and cursor
 * positions, dropping or duplicating groups across pages.
 *
 * `since` is null only for a lone-`until` query (an open lower bound); `until`
 * is always concrete (the request time when the caller gave none).
 */
function resolveWindow(query: GatewayUsageQuery): { since: Date | null; until: Date } {
  const until = query.until ?? new Date();
  const since =
    query.since ??
    (query.days !== undefined ? new Date(until.getTime() - query.days * 86_400_000) : null);
  return { since, until };
}

function timeWindowSql(window: { since: Date | null; until: Date }): SQL {
  const clauses: SQL[] = [sql`${logs.createdAt} < ${window.until.toISOString()}`];
  if (window.since) clauses.push(sql`${logs.createdAt} >= ${window.since.toISOString()}`);
  return and(...clauses)!;
}

/** The project's own rows, wherever billed (CostScope projectRowsLlm twin). */
function projectScopeSql(accountId: string, projectId: string): SQL {
  const projectSessionIds = db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(eq(projectSessions.projectId, projectId));
  return and(
    eq(logs.projectId, projectId),
    sql`(${logs.accountId} = ${accountId} or ${logs.sessionId} in ${projectSessionIds})`,
  )!;
}

export async function runGatewayUsageQuery(input: {
  accountId: string;
  projectId: string;
  query: GatewayUsageQuery;
  visibility: GatewayUsageVisibility;
}): Promise<GatewayUsageResult> {
  const { accountId, projectId, query, visibility } = input;
  const parent = alias(projectSessions, 'gw_usage_parent');
  const joinNeeded = needsSessionJoin(query.groupBy);

  // Visibility only matters when a session id is exposed (the per-session
  // route's rule). Model/agent/source/day are project-wide aggregates like
  // gateway overview/breakdown/sources. Applied to BOTH groups and totals so
  // one response's groups always sum consistently with its totals.
  const exposesSessions = query.groupBy.includes('session');
  const resolvedWindow = resolveWindow(query);
  const whereSql = and(
    projectScopeSql(accountId, projectId),
    timeWindowSql(resolvedWindow),
    exposesSessions ? visibility.sessionFilter : undefined,
  )!;

  // A $dynamic scan with the from + conditional joins + where already applied.
  const scan = (selection: Record<string, SQL>) => {
    const q = db.select(selection).from(logs).$dynamic();
    if (joinNeeded) {
      q.leftJoin(
        projectSessions,
        and(
          eq(projectSessions.sessionId, logs.sessionId),
          eq(projectSessions.projectId, logs.projectId),
        ),
      ).leftJoin(parent, eq(parent.sessionId, projectSessions.parentSessionId));
    }
    return q.where(whereSql);
  };

  // The ABSOLUTE window actually scanned. A drain pages against these exact
  // bounds (not the original `days`), so every page reads the same window.
  const window = {
    since: resolvedWindow.since ? resolvedWindow.since.toISOString() : null,
    until: resolvedWindow.until.toISOString(),
    days: query.days ?? null,
  };

  // Grand totals: one aggregate over the whole window, no group by.
  const [totalsRow] = (await scan({ ...aggregateSelection })) as AggregateRow[];
  const totalsAgg = totalsRow ?? EMPTY_AGGREGATE;
  const hasRows = numberValue(totalsAgg.requests) > 0;

  if (query.groupBy.length === 0) {
    const group: GatewayUsageGroup = {
      ...mapAggregate(totalsAgg),
      last_at: isoValue(totalsAgg.last_at),
    };
    const groups = hasRows ? [group] : [];
    const totals: GatewayUsageTotals = { ...mapAggregate(totalsAgg), groups: groups.length };
    return { group_by: [], window, valuation: llmValueBasis, groups, totals, next_cursor: null };
  }

  const dimExprs = query.groupBy.map((d) => dimensionExpr(d, parent));
  const sortKeyExpr = sql<string>`concat_ws(${SORT_KEY_SEP}, ${sql.join(
    dimExprs.map((e) => sql`coalesce(${e}::text, '')`),
    sql`, `,
  )})`;

  // Distinct group count for the totals, without draining every page.
  const [countRow] = (await db.select({ n: sql<number>`count(*)::int` }).from(
    scan({ k: sql`1` })
      .groupBy(...dimExprs)
      .as('g'),
  )) as Array<{ n: number }>;

  const totals: GatewayUsageTotals = {
    ...mapAggregate(totalsAgg),
    groups: countRow ? numberValue(countRow.n) : 0,
  };

  const dimSelection: Record<string, SQL> = {};
  for (const d of query.groupBy) dimSelection[`dim_${d}`] = dimensionExpr(d, parent);

  const having = query.cursor
    ? sql`(${totalSpendSql}, ${sortKeyExpr}) < (${query.cursor.cost}, ${query.cursor.key})`
    : sql`true`;

  const rows = (await scan({ ...dimSelection, ...aggregateSelection, sort_key: sortKeyExpr })
    .groupBy(...dimExprs)
    .having(having)
    .orderBy(sql`${totalSpendSql} desc`, sql`${sortKeyExpr} desc`)
    .limit(query.limit + 1)) as Array<AggregateRow & Record<string, unknown>>;

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const groups: GatewayUsageGroup[] = page.map((row) => {
    const group: GatewayUsageGroup = { ...mapAggregate(row), last_at: isoValue(row.last_at) };
    for (const d of query.groupBy) {
      const value = row[`dim_${d}`];
      if (d === 'session') group.session = value == null ? null : String(value);
      else group[d] = value == null ? 'unknown' : String(value);
    }
    return group;
  });

  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last
      ? encodeUsageCursor({ cost: numberValue(last.total_cost), key: String(last.sort_key) })
      : null;

  return { group_by: query.groupBy, window, valuation: llmValueBasis, groups, totals, next_cursor };
}
