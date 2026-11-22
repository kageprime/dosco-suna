import { describe, expect, test } from 'bun:test';

import {
  buildCostByProjectQuery,
  buildCostSummaryQuery,
  costReadBusyRetryDelay,
  retryCostReadBusy,
} from './use-cost-explorer';
import { buildSessionCostsListQuery } from './use-session-costs';

const sources = {
  summary: async () => ({ totals: {}, previous: {}, series: [], models: [] }) as never,
  byProject: async () =>
    ({ projects: [], total: 0, limit: 25, offset: 0, next_offset: null }) as never,
};

describe('buildCostSummaryQuery', () => {
  test('keys on every scope input so a level switch refetches', () => {
    const query = buildCostSummaryQuery(
      { accountId: 'a', projectId: 'p', sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    expect(query.queryKey).toEqual([
      'cost-explorer',
      'summary',
      { accountId: 'a', projectId: 'p', sessionId: null, from: 'F', to: 'T' },
    ]);
  });

  test('is disabled until an account id is known', () => {
    const query = buildCostSummaryQuery(
      { accountId: undefined, projectId: null, sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    expect(query.enabled).toBe(false);
  });

  test('drills from project scope to session scope by changing only sessionId', () => {
    const projectQuery = buildCostSummaryQuery(
      { accountId: 'a', projectId: 'p', sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    const sessionQuery = buildCostSummaryQuery(
      { accountId: 'a', projectId: 'p', sessionId: 's', from: 'F', to: 'T' },
      sources,
    );
    expect(projectQuery.queryKey).not.toEqual(sessionQuery.queryKey);
  });

  test('forwards the exact scope and window to the summary source', async () => {
    const calls: unknown[] = [];
    const query = buildCostSummaryQuery(
      { accountId: 'a', projectId: 'p', sessionId: 's', from: 'F', to: 'T' },
      {
        ...sources,
        summary: async (options) => {
          calls.push(options);
          return { totals: {}, previous: {}, series: [], models: [] } as never;
        },
      },
    );
    await query.queryFn();
    expect(calls).toEqual([{ accountId: 'a', projectId: 'p', sessionId: 's', from: 'F', to: 'T' }]);
    expect(query.staleTime).toBe(30_000);
  });
});

describe('buildCostByProjectQuery', () => {
  test('keys on window, sort and offset', () => {
    const query = buildCostByProjectQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
      sources,
    );
    expect(query.queryKey).toEqual([
      'cost-explorer',
      'by-project',
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
    ]);
  });

  test('is disabled until an account id is known', () => {
    const query = buildCostByProjectQuery(
      { accountId: undefined, from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    expect(query.enabled).toBe(false);
  });

  test('a changed window produces a different key than the original window', () => {
    const first = buildCostByProjectQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    const second = buildCostByProjectQuery(
      { accountId: 'a', from: 'F2', to: 'T2', sort: 'total_desc', offset: 0 },
      sources,
    );
    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  test('a changed sort produces a different key than the original sort', () => {
    const first = buildCostByProjectQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    const second = buildCostByProjectQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'name_asc', offset: 0 },
      sources,
    );
    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  test('forwards the exact account, window, sort and offset to the by-project source', async () => {
    const calls: unknown[] = [];
    const query = buildCostByProjectQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
      {
        ...sources,
        byProject: async (options) => {
          calls.push(options);
          return { projects: [], total: 0, limit: 25, offset: 25, next_offset: null } as never;
        },
      },
    );
    await query.queryFn();
    expect(calls).toEqual([
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', limit: 25, offset: 25 },
    ]);
    expect(query.staleTime).toBe(30_000);
  });
});

describe('cost_read_busy retry', () => {
  test('retries a 429 up to its bound and never another 4xx or 5xx', () => {
    expect(retryCostReadBusy(0, { status: 429 })).toBe(true);
    expect(retryCostReadBusy(19, { status: 429 })).toBe(true);
    expect(retryCostReadBusy(20, { status: 429 })).toBe(false);
    expect(retryCostReadBusy(0, { status: 403 })).toBe(false);
    expect(retryCostReadBusy(0, { status: 503 })).toBe(false);
    expect(retryCostReadBusy(0, new Error('boom'))).toBe(false);
    expect(retryCostReadBusy(0, null)).toBe(false);
  });

  test('waits about the server retry_after_seconds, with jitter', () => {
    for (let i = 0; i < 20; i++) {
      const delay = costReadBusyRetryDelay();
      expect(delay).toBeGreaterThanOrEqual(5_000);
      expect(delay).toBeLessThan(7_000);
    }
  });

  test('the three guarded cost reads carry the retry policy', () => {
    const summary = buildCostSummaryQuery({ accountId: 'a' }, sources);
    const byProject = buildCostByProjectQuery({ accountId: 'a', offset: 0 }, sources);
    const sessions = buildSessionCostsListQuery({ accountId: 'a', limit: 25, offset: 0 } as never);
    for (const query of [summary, byProject, sessions]) {
      expect(query.retry).toBe(retryCostReadBusy);
      expect(query.retryDelay).toBe(costReadBusyRetryDelay);
    }
  });
});
