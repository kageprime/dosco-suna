import { describe, expect, test } from 'bun:test';
import { InfiniteQueryObserver, QueryClient, onlineManager } from '@tanstack/react-query';

import {
  flattenSessionPages,
  sessionListState,
  sessionsNextCursor,
  shouldLoadMoreSessions,
  fetchUntilShownRowsGrow,
} from './session-pages';

const row = (session_id: string) => ({ session_id });

describe('session list pages', () => {
  test('next cursor: the page cursor, or undefined at the end (null would page forever)', () => {
    expect(sessionsNextCursor({ items: [], next_cursor: 'abc' })).toBe('abc');
    expect(sessionsNextCursor({ items: [], next_cursor: null })).toBeUndefined();
  });

  test('pages flatten in order; a row that moved between two fetches shows once', () => {
    const pages = [
      { items: [row('a'), row('b')], next_cursor: 'c1' },
      { items: [row('b'), row('c')], next_cursor: null },
    ];
    expect(flattenSessionPages({ pages }).map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
    expect(flattenSessionPages(undefined)).toEqual([]);
  });

  test('load more only when a next page exists and no page fetch is running', () => {
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: false, isRefreshing: false })).toBe(true);
    expect(shouldLoadMoreSessions({ hasNextPage: false, isFetchingNextPage: false, isRefreshing: false })).toBe(false);
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: true, isRefreshing: false })).toBe(false);
    // A pull to refresh refetches every loaded page; a next page on top would race it.
    expect(shouldLoadMoreSessions({ hasNextPage: true, isFetchingNextPage: false, isRefreshing: true })).toBe(false);
  });
});

describe('sessionListState (COR-146: a failure must never look like an empty list)', () => {
  test('loading wins over everything else — no page loaded yet', () => {
    expect(sessionListState({ isPending: true, isError: false, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isPending: true, isError: true, hasSessions: false })).toBe('loading');
    expect(sessionListState({ isPending: true, isError: false, hasSessions: true })).toBe('loading');
  });

  test('error only when the query failed and nothing survived to show', () => {
    expect(sessionListState({ isPending: false, isError: true, hasSessions: false })).toBe('error');
  });

  test('rows loaded through a failing background poll or refresh stay rows, not error', () => {
    expect(sessionListState({ isPending: false, isError: true, hasSessions: true })).toBe('rows');
  });

  test('empty only once the query succeeded with zero sessions', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: false })).toBe('empty');
  });

  test('rows once at least one session loaded and the query is not erroring', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: true })).toBe('rows');
  });
});

describe('sessionListState (KRTX-1727: zero rows with a cursor is not an empty list)', () => {
  test('no row loaded and a next page: more, never empty', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: false, hasMore: true })).toBe('more');
  });

  test('a failed next page keeps more: the Show more button is the retry', () => {
    expect(sessionListState({ isPending: false, isError: true, hasSessions: false, hasMore: true })).toBe('more');
  });

  test('rows and the first load win over more', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: true, hasMore: true })).toBe('rows');
    expect(sessionListState({ isPending: true, isError: false, hasSessions: false, hasMore: true })).toBe('loading');
  });

  test('no next page: empty as before', () => {
    expect(sessionListState({ isPending: false, isError: false, hasSessions: false, hasMore: false })).toBe('empty');
  });
});

describe('a list that has not loaded is never empty', () => {
  // The flags react-query really reports for the drawer's and the Sessions
  // page's query when the app is offline at its first load.
  test('offline, the first load pauses: loading, not "No sessions yet"', () => {
    onlineManager.setOnline(false);
    const client = new QueryClient();
    try {
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['project-sessions', 'p-1', 'paged'],
        queryFn: async () => ({ items: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: sessionsNextCursor,
      });
      const unsubscribe = observer.subscribe(() => {});
      const result = observer.getCurrentResult();

      expect(result.fetchStatus).toBe('paused');
      // `isLoading` reads a paused first load as "not loading": the old input.
      expect(result.isLoading).toBe(false);
      expect(result.isPending).toBe(true);
      expect(
        sessionListState({ isPending: result.isPending, isError: result.isError, hasSessions: false })
      ).toBe('loading');
      unsubscribe();
    } finally {
      client.clear();
      onlineManager.setOnline(true);
    }
  });

  test('once the first page lands with no rows: empty', async () => {
    const client = new QueryClient();
    try {
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['project-sessions', 'p-2', 'paged'],
        queryFn: async () => ({ items: [], next_cursor: null }),
        initialPageParam: null as string | null,
        getNextPageParam: sessionsNextCursor,
      });
      const unsubscribe = observer.subscribe(() => {});
      await client.getQueryCache().find({ queryKey: ['project-sessions', 'p-2', 'paged'] })?.promise;
      const result = observer.getCurrentResult();

      expect(
        sessionListState({ isPending: result.isPending, isError: result.isError, hasSessions: false })
      ).toBe('empty');
      unsubscribe();
    } finally {
      client.clear();
    }
  });
});


describe('fetchUntilShownRowsGrow (a Show more press always shows something new)', () => {
  type Row = { session_id: string; shown: boolean };
  // Each call answers the next page; `pages` is what the query holds after it.
  const reader = (answers: Array<{ items: Row[]; next: boolean; isError?: boolean }>) => {
    const pages: Array<{ items: Row[]; next_cursor: string | null }> = [];
    let calls = 0;
    const fetchNext = async () => {
      const answer = answers[calls++]!;
      if (!answer.isError) pages.push({ items: answer.items, next_cursor: answer.next ? 'c' : null });
      return { data: { pages: [...pages] }, hasNextPage: answer.next, isError: answer.isError };
    };
    return { fetchNext, calls: () => calls };
  };
  const shownCount = (rows: Row[]) => rows.filter((row) => row.shown).length;
  const hiddenRow = (id: string) => ({ session_id: id, shown: false });
  const shownRow = (id: string) => ({ session_id: id, shown: true });

  test('reads past pages whose rows the section does not show, and stops on the first shown row', async () => {
    const r = reader([
      { items: [hiddenRow('a')], next: true },
      { items: [hiddenRow('b')], next: true },
      { items: [shownRow('c')], next: true },
      { items: [shownRow('d')], next: true },
    ]);
    await fetchUntilShownRowsGrow({ fetchNext: r.fetchNext, shownCount, before: 0 });
    expect(r.calls()).toBe(3);
  });

  test('stops on the last page', async () => {
    const r = reader([{ items: [hiddenRow('a')], next: false }]);
    await fetchUntilShownRowsGrow({ fetchNext: r.fetchNext, shownCount, before: 0 });
    expect(r.calls()).toBe(1);
  });

  test('stops on a failure: the button is the retry', async () => {
    const r = reader([{ items: [], next: true, isError: true }]);
    await fetchUntilShownRowsGrow({ fetchNext: r.fetchNext, shownCount, before: 0 });
    expect(r.calls()).toBe(1);
  });

  test('counts growth from the rows already shown', async () => {
    const r = reader([
      { items: [hiddenRow('b')], next: true },
      { items: [shownRow('c')], next: true },
    ]);
    const fetchNext = async () => {
      const result = await r.fetchNext();
      return { ...result, data: { pages: [{ items: [shownRow('a')], next_cursor: 'c' }, ...result.data.pages] } };
    };
    await fetchUntilShownRowsGrow({ fetchNext, shownCount, before: 1 });
    expect(r.calls()).toBe(2);
  });

  test('a read that answers the same pages (a cancelled fetch) uses up the budget, never loops', async () => {
    let calls = 0;
    const same = { data: { pages: [{ items: [hiddenRow('a')], next_cursor: 'c' }] }, hasNextPage: true, isError: false };
    await fetchUntilShownRowsGrow({ fetchNext: async () => (calls++, same), shownCount, before: 0 });
    expect(calls).toBe(5);
  });

  test('reads at most the budget', async () => {
    const r = reader(Array.from({ length: 9 }, (_, i) => ({ items: [hiddenRow(`h${i}`)], next: true })));
    await fetchUntilShownRowsGrow({ fetchNext: r.fetchNext, shownCount, before: 0, budget: 3 });
    expect(r.calls()).toBe(3);
  });
});
