import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureKortix, listProjectSessionsPage } from '@kortix/sdk';

import {
  type SessionListFilter,
  type SessionScope,
  normalizeSessionListFilter,
  sessionsPageFilter,
} from './session-tree';

// The global `URLSearchParams` the app installs (`react-native-url-polyfill/auto`
// in api/supabase.ts): it has no `size`. Its package index loads react-native,
// and its `js/` entry ships no types.
const {
  URLSearchParams: PolyfillURLSearchParams,
}: {
  URLSearchParams: typeof URLSearchParams;
} = require('react-native-url-polyfill/js/URLSearchParams');

// KRTX-4898: every session list the app reads asks the server for its own
// bucket. With the polyfill, the SDK used to drop the whole query string, so
// the drawer's Sessions, Shared, Automated and Pinned lists and every Sessions
// page chip read the same unfiltered list.

configureKortix({
  backendUrl: 'https://api.example.test/v1',
  getToken: async () => 'synthetic-token',
});

const nativeURLSearchParams = globalThis.URLSearchParams;
const nativeFetch = globalThis.fetch;
const requested: URL[] = [];
beforeAll(() => {
  globalThis.URLSearchParams = PolyfillURLSearchParams;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requested.push(new URL(String(input instanceof Request ? input.url : input)));
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    },
    { preconnect: nativeFetch.preconnect },
  );
});
afterAll(() => {
  globalThis.URLSearchParams = nativeURLSearchParams;
  globalThis.fetch = nativeFetch;
});

/** The request `useProjectSessionsPaged` sends for `filter`. */
async function requestFor(filter: SessionListFilter, limit?: number): Promise<URL> {
  await listProjectSessionsPage('p-1', {
    ...normalizeSessionListFilter(filter),
    limit,
    cursor: null,
  });
  const url = requested.at(-1);
  if (!url) throw new Error('no request');
  return url;
}

describe('session list requests under the app URL polyfill', () => {
  test('the polyfill has no size, as on the phone', () => {
    expect('size' in new PolyfillURLSearchParams()).toBe(false);
  });

  test('each Sessions page chip asks for its own starter bucket', async () => {
    const buckets: [SessionScope, string][] = [
      ['all', 'humans'],
      ['mine', 'me'],
      ['shared', 'others'],
      ['automated', 'automated'],
    ];
    for (const [scope, startedBy] of buckets) {
      const url = await requestFor(sessionsPageFilter({ scope, archived: false }));
      expect(url.searchParams.get('parent')).toBe('root');
      expect(url.searchParams.get('started_by')).toBe(startedBy);
    }
    const archived = await requestFor(
      sessionsPageFilter({ scope: 'automated', archived: true, q: 'nightly' }),
    );
    expect(archived.searchParams.get('archived')).toBe('only');
    expect(archived.searchParams.get('started_by')).toBe('automated');
    expect(archived.searchParams.get('q')).toBe('nightly');
  });

  test("the drawer's four lists ask for four different buckets", async () => {
    const mine = await requestFor({ parent: 'root', startedBy: 'me' });
    expect(mine.search).toBe('?parent=root&started_by=me');
    const automated = await requestFor({ parent: 'root', startedBy: 'automated' }, 20);
    expect(automated.search).toBe('?limit=20&parent=root&started_by=automated');
    const shared = await requestFor({ parent: 'root', startedBy: 'others' }, 20);
    expect(shared.search).toBe('?limit=20&parent=root&started_by=others');
    const pinned = await requestFor({ view: 'pinned' }, 20);
    expect(pinned.search).toBe('?limit=20&pinned=only');
  });
});
