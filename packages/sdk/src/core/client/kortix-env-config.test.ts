import { afterEach, expect, mock, test } from 'bun:test';
import { createKortix } from './kortix';

// Inside a Kortix sandbox (a session, a program agent's turn) the box already
// holds its own API base and token: `KORTIX_API_URL` (ending in `/v1`) and
// `KORTIX_TOKEN`. `createKortix()` with no config uses them.

const realFetch = globalThis.fetch;
const saved = { url: process.env.KORTIX_API_URL, token: process.env.KORTIX_TOKEN };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.KORTIX_API_URL = saved.url;
  process.env.KORTIX_TOKEN = saved.token;
  if (saved.url === undefined) delete process.env.KORTIX_API_URL;
  if (saved.token === undefined) delete process.env.KORTIX_TOKEN;
});

test('createKortix() with no config calls KORTIX_API_URL with KORTIX_TOKEN', async () => {
  process.env.KORTIX_API_URL = 'http://box-api.test/v1/';
  process.env.KORTIX_TOKEN = 'kortix_pat_box';
  const seen: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    seen.push({ url: String(input), auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const kortix = createKortix();
  await kortix.projects.list().catch(() => undefined);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]!.url.startsWith('http://box-api.test/v1/')).toBe(true);
  expect(seen[0]!.auth).toBe('Bearer kortix_pat_box');
});

test('createKortix() with no config and no KORTIX_API_URL throws a message that says what to set', () => {
  delete process.env.KORTIX_API_URL;
  delete process.env.KORTIX_TOKEN;
  expect(() => createKortix()).toThrow(/KORTIX_API_URL/);
});
