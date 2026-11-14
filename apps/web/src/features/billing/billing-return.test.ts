import { describe, expect, test } from 'bun:test';

import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { BILLING_RETURNS, BILLING_RETURN_PARAMS, refreshModelAvailability } from './billing-return';

/**
 * The contract these tests protect: a Stripe return is handled wherever the
 * user lands, so no `success_url` has to point at the projects list.
 */
describe('billing returns', () => {
  test('every return declares a distinct param', () => {
    const params = BILLING_RETURNS.map((r) => r.param);
    expect(new Set(params).size).toBe(params.length);
  });

  test('BILLING_RETURN_PARAMS matches the table', () => {
    // The door preserves these across its redirect; a drift here silently
    // swallows a post-checkout refresh.
    expect([...BILLING_RETURN_PARAMS].sort()).toEqual(BILLING_RETURNS.map((r) => r.param).sort());
  });

  test('covers the live Stripe flows', () => {
    expect(BILLING_RETURNS.map((r) => r.param).sort()).toEqual(['credit_purchase', 'enterprise_contract', 'team_signup']);
  });

  test('a one-time top-up answers with the receipt dialog; the rest keep the toast', () => {
    // The receipt shows the new balance and the way back to work. A plan or a
    // contract activation has no single number to report, so it stays a toast.
    const acks = Object.fromEntries(BILLING_RETURNS.map((r) => [r.param, r.ack ?? 'toast']));
    expect(acks).toEqual({
      credit_purchase: 'dialog',
      enterprise_contract: 'toast',
      team_signup: 'toast',
    });
  });

  test('every return has user-facing copy and a settle step', () => {
    for (const entry of BILLING_RETURNS) {
      expect({ param: entry.param, ok: entry.title.length > 0 }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect({ param: entry.param, ok: entry.description.length > 0 }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect({ param: entry.param, ok: typeof entry.settle === 'function' }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect(entry.value).toBe('success');
    }
  });
});

/**
 * F-004: after a plan checkout the composer kept "No model" until a reload.
 * The page Stripe returns to reads the model lists while the account is still
 * Free, then the return moves the plan. Those reads must not survive it.
 */
describe('refreshModelAvailability', () => {
  /** A read that answers "Free" first and "Credits" on every later call. */
  function planRead<T>(free: T, credits: T) {
    let calls = 0;
    let releaseFirst: (value: T) => void = () => {};
    const queryFn = () => {
      calls += 1;
      if (calls > 1) return Promise.resolve(credits);
      return new Promise<T>((resolve) => {
        releaseFirst = resolve;
      });
    };
    return { queryFn, releaseFirst: () => releaseFirst(free) };
  }

  async function settled(queryClient: QueryClient, key: readonly unknown[]) {
    for (let i = 0; i < 50 && queryClient.getQueryState(key)?.fetchStatus !== 'idle'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return queryClient.getQueryData(key);
  }

  test('a model list read in flight before the plan moved does not win', async () => {
    const queryClient = new QueryClient();
    const key = qk.project.modelPicker('p1');
    const read = planRead({ models: {} }, { models: { 'deepseek-v4.1-flash': {} } });
    queryClient.setQueryData(key, { models: {} });
    // The composer's `useWorkspaceModels` observer, mid-refetch.
    const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn: read.queryFn }).subscribe(() => {});

    await refreshModelAvailability(queryClient);
    read.releaseFirst();

    expect(await settled(queryClient, key)).toEqual({ models: { 'deepseek-v4.1-flash': {} } });
    unsubscribe();
  });

  test('a first model-defaults read in flight before the plan moved does not win', async () => {
    const queryClient = new QueryClient();
    const key = ['model-defaults', 'p1'];
    const read = planRead({ freeTier: true }, { freeTier: false });
    // `useModelDefaults`'s observer, on its first read.
    const unsubscribe = new QueryObserver(queryClient, { queryKey: key, queryFn: read.queryFn }).subscribe(() => {});

    await refreshModelAvailability(queryClient);
    read.releaseFirst();

    expect(await settled(queryClient, key)).toEqual({ freeTier: false });
    unsubscribe();
  });
});
