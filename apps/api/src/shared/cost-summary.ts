import { numberValue, type NumericValue } from './cost-values';
import type { CostWindow } from './cost-window';
export interface CostSeriesPoint {
  day: string;
  llm_cost: number;
  compute_cost: number;
  /** Volume storage charged for the UTC day. */
  storage_cost: number;
  total_cost: number;
}

interface DailyCostRow {
  day: string;
  cost: number | string;
}

// Gap days are emitted as zero, not omitted. A chart that silently skips
// empty days compresses time and makes a spike look like a trend.
export function buildCostSeries(
  llmDays: DailyCostRow[],
  computeDays: DailyCostRow[],
  window: CostWindow,
  storageDays: DailyCostRow[] = [],
): CostSeriesPoint[] {
  const llmByDay = new Map(llmDays.map((row) => [row.day, numberValue(row.cost)]));
  const computeByDay = new Map(computeDays.map((row) => [row.day, numberValue(row.cost)]));
  const storageByDay = new Map(storageDays.map((row) => [row.day, numberValue(row.cost)]));

  const points: CostSeriesPoint[] = [];
  const cursor = new Date(
    Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), window.from.getUTCDate()),
  );

  while (cursor.getTime() < window.to.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const llmCost = llmByDay.get(day) ?? 0;
    const computeCost = computeByDay.get(day) ?? 0;
    const storageCost = storageByDay.get(day) ?? 0;
    points.push({
      day,
      llm_cost: llmCost,
      compute_cost: computeCost,
      storage_cost: storageCost,
      total_cost: Number((llmCost + computeCost + storageCost).toFixed(10)),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}

export interface CostSummaryTotals {
  llm_cost: number;
  /** Alias of `llm_cost`, retained for the additive payee breakdown. */
  llm_kortix_cost: number;
  /** Provider-side BYOK spend. Excluded from `llm_cost` and `total_cost`. */
  llm_provider_cost: number;
  compute_cost: number;
  /** Volume storage charged in the window (storage_charges), included in total_cost. */
  storage_cost: number;
  total_cost: number;
  request_count: number;
  compute_seconds: number;
  /** GiB-hours of volume storage behind storage_cost. */
  storage_gib_hours: number;
  session_count: number;
  project_count: number;
}

export interface CostModelRow {
  provider: string;
  model: string;
  cost: number;
  request_count: number;
}

export interface CostSummary {
  totals: CostSummaryTotals;
  previous: { total_cost: number };
  series: CostSeriesPoint[];
  models: CostModelRow[];
}

type LlmRow = { setId: string; day: string | null; projectId: string | null; provider: string | null; model: string | null; llmCost: number | string; llmKortixCost: NumericValue; llmProviderCost: NumericValue; requestCount: NumericValue; sessionCount: NumericValue };
type ComputeRow = { setId: string; day: string | null; projectId: string | null; computeCost: number | string; computeSeconds: NumericValue; sessionCount: NumericValue };
type StorageRow = { day: string; cost: number | string; gibHours: NumericValue; projectIds: string[] | null };
type PriorRow = { cost: NumericValue };

export function assembleCostSummary(window: CostWindow, llmGroupRows: LlmRow[], llmPriorRows: PriorRow[], computeGroupRows: ComputeRow[], computePriorRows: PriorRow[], storageDayRows: StorageRow[], storagePriorRows: PriorRow[]): CostSummary {
  // Split the grouped rows by their set label. The grand-total row is the
  // one row whose set has no grouping column; an empty window still returns
  // it (aggregate without GROUP BY), while every grouped set returns none —
  // the same shapes the per-query version produced.
  const llmTotals = llmGroupRows.find((row) => row.setId === 'totals');
  const computeTotals = computeGroupRows.find((row) => row.setId === 'totals');

  const llmDailyRows: DailyCostRow[] = [];
  const computeDailyRows: DailyCostRow[] = [];
  for (const row of llmGroupRows) {
    if (row.setId === 'day' && row.day) llmDailyRows.push({ day: row.day, cost: row.llmCost });
  }
  for (const row of computeGroupRows) {
    if (row.setId === 'day' && row.day) computeDailyRows.push({ day: row.day, cost: row.computeCost });
  }

  // The true union of distinct project ids across both sources, not just
  // the LLM side's count: a project can have compute spend and zero
  // gateway_request_logs rows in the window (a session whose compute
  // started inside the window but whose LLM calls fell outside it, or a
  // project on BYO keys with no gateway rows at all), and listCostByProject
  // above already treats such a project as real (mergeProjectCostRows's
  // compute loop calls ensure(row.projectId) same as the LLM loop). The
  // grouping sets produce this as the rows of each source's project set;
  // the compute side's LEFT JOIN adds a NULL group for unassigned spend,
  // which the `row.projectId` guard drops the same way the ungrouped
  // version's INNER JOIN never saw those rows at all.
  const projectIds = new Set<string>();
  for (const row of llmGroupRows) {
    if (row.setId === 'project' && row.projectId) projectIds.add(row.projectId);
  }
  for (const row of computeGroupRows) {
    if (row.setId === 'project' && row.projectId) projectIds.add(row.projectId);
  }
  for (const row of storageDayRows) {
    for (const id of row.projectIds ?? []) projectIds.add(id);
  }

  // Cost descending, then provider/model descending as a deterministic
  // tie-break — the same rule the ungrouped version ordered by in SQL.
  // ponytail: the tie-break compares code units, not the DB collation —
  // identical for the ASCII provider/model slugs; move the ordering back
  // into SQL (a per-set LIMIT can't live inside GROUPING SETS) if a
  // non-ASCII model name ever needs exact SQL tie order.
  const models = llmGroupRows
    .filter((row) => row.setId === 'model')
    .map((row) => {
      // provider and resolved_model are the grouping columns of the 'model'
      // set and both are NOT NULL, so null here means the set marker or the
      // schema drifted. An empty string is a real value (a prod row had
      // provider = '' on 2026-10-17): test for null, never truthiness.
      if (row.provider === null || row.model === null) {
        throw new Error(`model grouping-set row without provider/model: ${JSON.stringify(row)}`);
      }
      return {
        provider: row.provider,
        model: row.model,
        cost: numberValue(row.llmCost),
        request_count: numberValue(row.requestCount),
      };
    })
    .sort((left, right) => {
      const byCost = right.cost - left.cost;
      if (byCost) return byCost;
      if (left.provider !== right.provider) return left.provider < right.provider ? 1 : -1;
      if (left.model === right.model) return 0;
      return left.model < right.model ? 1 : -1;
    })
    .slice(0, 10);

  const llmCost = numberValue(llmTotals?.llmCost);
  const computeCost = numberValue(computeTotals?.computeCost);
  const storageCost = storageDayRows.reduce((sum, row) => sum + numberValue(row.cost), 0);

  const totals: CostSummaryTotals = {
    llm_cost: llmCost,
    llm_kortix_cost: numberValue(llmTotals?.llmKortixCost),
    llm_provider_cost: numberValue(llmTotals?.llmProviderCost),
    compute_cost: computeCost,
    storage_cost: Number(storageCost.toFixed(10)),
    total_cost: Number((llmCost + computeCost + storageCost).toFixed(10)),
    request_count: numberValue(llmTotals?.requestCount),
    compute_seconds: numberValue(computeTotals?.computeSeconds),
    storage_gib_hours: storageDayRows.reduce((sum, row) => sum + numberValue(row.gibHours), 0),
    // The larger of the two sources' distinct session counts — NOT the true
    // union: a session with LLM-only spend and a different session with
    // compute-only spend both go uncounted by Math.max the same way they
    // would under- or over-count with either side alone. This follows
    // mergeProjectCostRows's established convention above (same
    // approximation, same tradeoff) rather than diverging with a more
    // accurate but novel calculation.
    session_count: Math.max(
      numberValue(llmTotals?.sessionCount),
      numberValue(computeTotals?.sessionCount),
    ),
    // The true union of distinct project ids across both sources, not just
    // the LLM side's count: a project can have compute spend and zero
    // gateway_request_logs rows in the window (a session whose compute
    // started inside the window but whose LLM calls fell outside it, or a
    // project on BYO keys with no gateway rows at all), and listCostByProject
    // above already treats such a project as real (mergeProjectCostRows's
    // compute loop calls ensure(row.projectId) same as the LLM loop). This is
    // a separate, non-money query (projectIds), so it does not touch the
    // total_cost completeness constraint documented on computeScope above —
    // that constraint binds the money queries, not a distinct-id count.
    project_count: projectIds.size,
  };

  const previousTotalCost = Number(
    (numberValue(llmPriorRows[0]?.cost) + numberValue(computePriorRows[0]?.cost) + numberValue(storagePriorRows[0]?.cost)).toFixed(10),
  );

  return {
    totals,
    previous: { total_cost: previousTotalCost },
    series: buildCostSeries(
      llmDailyRows,
      computeDailyRows,
      window,
      storageDayRows.map((row) => ({ day: row.day, cost: row.cost })),
    ),
    models,
  };
}
