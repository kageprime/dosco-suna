import { afterAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import type { MiddlewareAuth } from '@/lib/supabase/middleware-identity';

// A signed-in installed desktop shell opens its pre-Workspaces paths
// (/projects…, /new). The middleware must rewrite them onto the /workspaces
// pages: a next.config rewrite runs after the middleware and sees only
// /en/projects/…, so on prod every signed-in shell launch answered 404.
const user = { id: '22222222-2222-4222-8222-222222222222', user_metadata: { locale: 'en' } };
const getClaims = mock<MiddlewareAuth['getClaims']>(async () => ({
  data: { claims: { sub: user.id } }, error: null,
}));
const getUser = mock<MiddlewareAuth['getUser']>(async () => ({ data: { user }, error: null }));
// Only the external auth collaborator is replaced; the middleware runs as is.
mock.module('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getClaims, getUser } }) }));
const { middleware } = await import('./middleware');
afterAll(() => mock.restore());

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36 KortixDesktop/0.1.0';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Safari/537.36';

function signedIn(path: string, userAgent: string): NextRequest {
  const session = `base64-${Buffer.from(JSON.stringify({
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url')}`;
  const request = new NextRequest(`https://kortix.test${path}`, { headers: { 'user-agent': userAgent } });
  request.cookies.set(KORTIX_SUPABASE_AUTH_COOKIE, session);
  return request;
}

function rewrittenPath(response: Response): string | null {
  const rewrite = response.headers.get('x-middleware-rewrite');
  return rewrite ? new URL(rewrite).pathname : null;
}

describe('a signed-in desktop shell gets the /workspaces page for its legacy paths', () => {
  test.each([
    ['/projects/start', '/en/workspaces/start'],
    ['/projects', '/en/workspaces'],
    ['/projects/p1', '/en/workspaces/p1'],
    ['/projects/p1/sessions/s1', '/en/workspaces/p1/sessions/s1'],
    ['/new', '/en/workspaces/new'],
    ['/de/projects/p1', '/de/workspaces/p1'],
  ])('%s renders %s in place', async (path, page) => {
    const response = await middleware(signedIn(path, DESKTOP_UA));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(rewrittenPath(response)).toBe(page);
  });

  test('a /workspaces path and a non-legacy path keep their page', async () => {
    expect(rewrittenPath(await middleware(signedIn('/workspaces/start', DESKTOP_UA)))).toBe('/en/workspaces/start');
    expect(rewrittenPath(await middleware(signedIn('/settings/billing', DESKTOP_UA)))).toBe('/en/settings/billing');
    expect(rewrittenPath(await middleware(signedIn('/newsletter', DESKTOP_UA)))).not.toBe('/en/workspaces/newsletter');
  });

  test('a browser never gets the desktop mapping', async () => {
    expect(rewrittenPath(await middleware(signedIn('/workspaces/start', BROWSER_UA)))).toBe('/en/workspaces/start');
  });
});
