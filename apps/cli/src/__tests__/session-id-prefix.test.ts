import { describe, expect, it } from 'bun:test';

import type { ApiClient } from '../api/client.ts';
import { expandSessionIdPrefix, sessionIdArgs } from '../command-helpers.ts';

/** A workspace with more sessions than one list page (the API's default is 50). */
const ids = Array.from({ length: 60 }, (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);

function fakeClient(requests: string[]): ApiClient {
  const page = (path: string) => {
    const url = new URL(path, 'http://x');
    const q = url.searchParams.get('q');
    if (url.searchParams.get('archived') === 'only') return [];
    const rows = ids.map((session_id) => ({ session_id }));
    // Like the API: `q` matches an id prefix (among other fields); without it, one page of 50.
    return q ? rows.filter((r) => r.session_id.startsWith(q)) : rows.slice(0, 50);
  };
  return {
    apiBase: 'http://x/v1',
    get: async <T,>(path: string) => {
      requests.push(path);
      return page(path) as T;
    },
    post: async () => { throw new Error('unexpected'); },
    put: async () => { throw new Error('unexpected'); },
    patch: async () => { throw new Error('unexpected'); },
    delete: async () => { throw new Error('unexpected'); },
  };
}

describe('expandSessionIdPrefix', () => {
  it('finds a short id beyond the first list page', async () => {
    const requests: string[] = [];
    const found = await expandSessionIdPrefix(fakeClient(requests), 'proj', ids[55]!.slice(0, 8));
    expect(found).toEqual({ session_id: ids[55]! } as never);
  });

  it('expands every one of 13 short ids', async () => {
    const requests: string[] = [];
    const client = fakeClient(requests);
    const picked = ids.slice(47, 60);
    const results = await Promise.all(picked.map((id) => expandSessionIdPrefix(client, 'proj', id.slice(0, 8))));
    expect(results.map((r) => (r as { session_id: string } | null)?.session_id)).toEqual(picked);
  });

  it('never sends the prefix as a session id', async () => {
    const requests: string[] = [];
    expect(await expandSessionIdPrefix(fakeClient(requests), 'proj', 'ffffffff')).toBeNull();
    expect(requests.some((p) => p.includes('/sessions/ffffffff'))).toBe(false);
  });
});

describe('sessionIdArgs', () => {
  it('splits one argument that holds several ids (an unsplit shell variable) and drops flags', () => {
    expect(sessionIdArgs(['4604dadb e7f0cf5c,b0ec19e3', '--yes', 'eea3f9c6\n'])).toEqual([
      '4604dadb',
      'e7f0cf5c',
      'b0ec19e3',
      'eea3f9c6',
    ]);
  });
});
