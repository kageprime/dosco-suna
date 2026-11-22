import {
  getCostSummary,
  listCostByProject,
  type CostSeriesPoint,
  type CostSummary,
  type GetCostSummaryOptions,
  type ListCostByProjectOptions,
  type ProjectCostPage,
  type ProjectCostSort,
} from '@kortix/sdk';
import { useQueries, useQuery } from '@tanstack/react-query';

import { useBillingAccountId } from '../stores/billing-account-context';

/** Rows per page for the account-wide project cost rollup (`GET
 *  /usage/cost-by-project`) — mirrors `SESSION_COST_PAGE_SIZE` in
 *  `use-session-costs.ts`. */
export const COST_PAGE_SIZE = 25;
const COST_EXPLORER_STALE_TIME_MS = 30_000;

/**
 * The API answers 429 `cost_read_busy` when more cost reads are queued on one
 * replica than its guard allows (`apps/api/src/shared/cost-read-guard.ts`). The
 * workspace heatmap issues one summary read per visible workspace (up to
 * `COST_PAGE_SIZE`), so most of them meet that 429 on a large account. It is a
 * "try again shortly" signal, not a failure: the shared query client never
 * retries a 4xx, so these queries retry it themselves, every ~5 s (the
 * server's `retry_after_seconds`), until the queue has drained.
 */
const COST_BUSY_MAX_RETRIES = 20;
const COST_BUSY_RETRY_MS = 5_000;

export function retryCostReadBusy(failureCount: number, error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 429 && failureCount < COST_BUSY_MAX_RETRIES;
}

/** 5 s plus up to 2 s of jitter so the queued reads do not retry in lockstep. */
export function costReadBusyRetryDelay(): number {
  return COST_BUSY_RETRY_MS + Math.random() * 2_000;
}

export interface CostExplorerSources {
  summary(options?: GetCostSummaryOptions): Promise<CostSummary>;
  byProject(options?: ListCostByProjectOptions): Promise<ProjectCostPage>;
}

const sdkSources: CostExplorerSources = {
  summary: getCostSummary,
  byProject: listCostByProject,
};

export interface CostSummaryQueryInput {
  accountId?: string;
  projectId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}

export interface CostByProjectQueryInput {
  accountId?: string;
  from?: string;
  to?: string;
  sort?: ProjectCostSort;
  offset: number;
}

/**
 * Account/project/session spend summary — powers the totals, trend series
 * and top-models breakdown at whichever level of the Project -> Sessions ->
 * Session drill-down the caller is on. The query key carries every scope
 * input (account, project, session, window) so switching levels or changing
 * the date window refetches instead of serving a stale page under the new
 * heading.
 */
export function buildCostSummaryQuery(
  input: CostSummaryQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    from: input.from,
    to: input.to,
  };
  const options: GetCostSummaryOptions = {
    accountId: input.accountId,
    projectId: input.projectId ?? undefined,
    sessionId: input.sessionId ?? undefined,
    from: input.from,
    to: input.to,
  };

  return {
    queryKey: ['cost-explorer', 'summary', keyInput] as const,
    queryFn: () => sources.summary(options),
    enabled: Boolean(input.accountId),
    staleTime: COST_EXPLORER_STALE_TIME_MS,
    retry: retryCostReadBusy,
    retryDelay: costReadBusyRetryDelay,
  };
}

/**
 * Account-wide project cost rollup — powers the top-level "by project" table
 * of the cost explorer. The query key carries the window, sort and offset so
 * paging, re-sorting or changing the date window all refetch.
 */
export function buildCostByProjectQuery(
  input: CostByProjectQueryInput,
  sources: CostExplorerSources = sdkSources,
) {
  const keyInput = {
    accountId: input.accountId ?? null,
    from: input.from,
    to: input.to,
    sort: input.sort,
    offset: input.offset,
  };
  const options: ListCostByProjectOptions = {
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    sort: input.sort,
    limit: COST_PAGE_SIZE,
    offset: input.offset,
  };

  return {
    queryKey: ['cost-explorer', 'by-project', keyInput] as const,
    queryFn: () => sources.byProject(options),
    enabled: Boolean(input.accountId),
    staleTime: COST_EXPLORER_STALE_TIME_MS,
    retry: retryCostReadBusy,
    retryDelay: costReadBusyRetryDelay,
  };
}

export function useCostSummary(input: {
  projectId?: string | null;
  sessionId?: string | null;
  from?: string;
  to?: string;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostSummaryQuery({
      accountId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      from: input.from,
      to: input.to,
    }),
  );
}

export function useCostByProject(input: {
  from?: string;
  to?: string;
  sort?: ProjectCostSort;
  offset: number;
}) {
  const accountId = useBillingAccountId();
  return useQuery(
    buildCostByProjectQuery({
      accountId,
      from: input.from,
      to: input.to,
      sort: input.sort,
      offset: input.offset,
    }),
  );
}

/**
 * One daily cost series per workspace, for the workspace-by-day heatmap on the
 * top level of the explorer. Each entry is the same `cost-summary` query the
 * drill-down issues for that workspace (`useCostSummary({ projectId })`), with
 * the same key, so opening a workspace after seeing its heatmap row reads from
 * cache instead of fetching again.
 *
 * Bounded by the caller: it passes the workspaces on the visible page (at most
 * `COST_PAGE_SIZE`). A workspace whose series has not arrived maps to
 * `undefined`, which the heatmap draws as a loading strip, never as zeros. A
 * workspace whose request failed maps to `null`: no series to draw, and no
 * loading strip that would never end.
 */
export function useWorkspaceDailySeries(input: {
  projectIds: readonly string[];
  from?: string;
  to?: string;
}): Record<string, CostSeriesPoint[] | null | undefined> {
  const accountId = useBillingAccountId();
  return useQueries({
    queries: input.projectIds.map((projectId) =>
      buildCostSummaryQuery({ accountId, projectId, sessionId: null, from: input.from, to: input.to }),
    ),
    combine: (results) => {
      const byProject: Record<string, CostSeriesPoint[] | null | undefined> = {};
      results.forEach((result, index) => {
        byProject[input.projectIds[index]!] = result.isError ? null : result.data?.series;
      });
      return byProject;
    },
  });
}
