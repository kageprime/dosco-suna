import { expect, test } from 'bun:test';
// The matcher Next itself compiles `redirects()` sources with. It ships no types.
// @ts-expect-error -- next/dist/compiled/path-to-regexp has no declaration file.
import * as pathToRegexp from 'next/dist/compiled/path-to-regexp';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import type { NextConfig } from 'next';

import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

const { match } = pathToRegexp as {
  match: (source: string, options: { decode: (value: string) => string }) => (path: string) => false | { params: object };
};

// KRTX-4462: /app is an old app URL. The middleware answered it with the 404
// page (not a public or protected route), so the request never reached the
// download page. next.config redirects() runs before the middleware and keeps
// the query string when the destination has none.
test('/app redirects to /download, permanently', async () => {
  const redirects = (await resolved.redirects?.()) ?? [];
  const rule = redirects.find((candidate) => candidate.source === '/app');
  expect(rule).toMatchObject({ destination: '/download', permanent: true });
});

test('only the exact /app path redirects; look-alikes do not', async () => {
  const redirects = (await resolved.redirects?.()) ?? [];
  const rule = redirects.find((candidate) => candidate.source === '/app');
  if (!rule) throw new Error('no /app redirect rule in next.config.ts');
  const matches = (path: string) => match(rule.source, { decode: decodeURIComponent })(path);
  expect(matches('/app')).toBeTruthy();
  for (const path of ['/apps', '/app/install', '/download']) expect(matches(path)).toBeFalsy();
});
