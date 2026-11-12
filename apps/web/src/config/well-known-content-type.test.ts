import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

// Apple reads the association file as JSON: Universal Links for /share and
// /auth/callback, and shared web credentials. The file has no extension, so
// it was served as application/octet-stream (KRTX-3255).
test('the Apple app-site-association file is served as JSON', async () => {
  const rules = await resolved.headers?.();
  const headers = rules?.find((rule) => rule.source === '/.well-known/apple-app-site-association')?.headers;
  expect(headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
});

// iOS opens the app for every URL the file claims. A web sign-in on an iPhone
// with the app installed ends on /auth/callback, so a bare `/auth/callback`
// claim sent every web login to the app, which rejects a callback without
// `mobile_callback=1`: the user could not sign in on the web at all. Only the
// app's own handoff (`?mobile_callback=1`) may open the app.
test('the app claims /auth/callback only for the mobile handoff', async () => {
  const file = Bun.file(new URL('../../public/.well-known/apple-app-site-association', import.meta.url));
  const aasa = (await file.json()) as {
    applinks: { details: { paths?: string[]; components?: { '/': string; '?'?: Record<string, string> }[] }[] };
  };
  const [detail] = aasa.applinks.details;
  expect(detail.paths).toBeUndefined();
  const callbackRules = (detail.components ?? []).filter((rule) => rule['/'].startsWith('/auth'));
  expect(callbackRules).toEqual([{ '/': '/auth/callback', '?': { mobile_callback: '1' } }]);
});
