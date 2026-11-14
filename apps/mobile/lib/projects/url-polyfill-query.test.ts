import { afterAll, beforeAll, expect, test } from 'bun:test';
import { configureKortix, listProjectSessionsPage } from '@kortix/sdk';

// The URLSearchParams `api/supabase.ts` installs on the device
// (`react-native-url-polyfill/auto`): whatwg-url-without-unicode, no `size`.
// The subpath, not the package root: the root imports react-native.
const { URLSearchParams: DeviceURLSearchParams }: { URLSearchParams: typeof URLSearchParams } = require(
  'react-native-url-polyfill/js/URLSearchParams'
);

// The Sessions page sent its search, starter filter and cursor through this
// call. Under the device's URLSearchParams every one of them was dropped: the
// list showed every session whatever the search or the chip.
const requested: string[] = [];
const native = globalThis.URLSearchParams;
const nativeFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.URLSearchParams = DeviceURLSearchParams;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    { preconnect: nativeFetch.preconnect }
  );
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
});
afterAll(() => {
  globalThis.URLSearchParams = native;
  globalThis.fetch = nativeFetch;
});

test('the Sessions page query reaches the server under the device URLSearchParams', async () => {
  expect(new DeviceURLSearchParams('a=1').size).toBeUndefined();
  await listProjectSessionsPage('p-1', { parent: 'root', startedBy: 'humans', q: 'biomarkers', cursor: 'c-2' });
  const url = new URL(requested[requested.length - 1]);
  expect(url.pathname).toBe('/v1/workspaces/p-1/sessions');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    parent: 'root',
    started_by: 'humans',
    q: 'biomarkers',
    cursor: 'c-2',
  });
});
