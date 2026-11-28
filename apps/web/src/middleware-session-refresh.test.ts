import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { getMaintenanceConfig, setMaintenanceConfig } from '@/lib/maintenance-store';
import type { MiddlewareAuth } from '@/lib/supabase/middleware-identity';

const user = { id: '11111111-1111-4111-8111-111111111111', user_metadata: { locale: 'de' } };
const getClaims = mock<MiddlewareAuth['getClaims']>(async () => ({
  data: { claims: { sub: user.id } }, error: null,
}));
const getUser = mock<MiddlewareAuth['getUser']>(async () => ({ data: { user }, error: null }));
const createServerClient = mock(() => ({ auth: { getClaims, getUser } }));
// Only the external auth collaborator is replaced; middleware and its identity
// resolver execute normally. No session_id means liveness is checked every time.
mock.module('@supabase/ssr', () => ({ createServerClient }));
const { middleware } = await import('./middleware');

beforeEach(() => {
  createServerClient.mockClear();
  getClaims.mockReset();
  getUser.mockReset();
  getClaims.mockResolvedValue({ data: { claims: { sub: user.id } }, error: null });
  getUser.mockResolvedValue({ data: { user }, error: null });
});
afterAll(() => mock.restore());

function sessionRequest(secondsUntilExpiry: number) {
  const value = `base64-${Buffer.from(JSON.stringify({
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + secondsUntilExpiry,
  })).toString('base64url')}`;
  const request = new NextRequest('https://example.test/workspaces');
  request.cookies.set(KORTIX_SUPABASE_AUTH_COOKIE, value);
  return { request, value };
}

function expectAuthBounce(response: Response) {
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.pathname).toBe('/auth');
  expect(location.searchParams.get('redirect')).toBe('/workspaces');
  // The request carried a session, so /auth must say it ended (KRTX-1978).
  expect(location.searchParams.get('reason')).toBe('session_ended');
}

function expectRetained(request: NextRequest, value: string, response: Response) {
  expect(request.cookies.get(KORTIX_SUPABASE_AUTH_COOKIE)?.value).toBe(value);
  expect(response.headers.getSetCookie().filter((cookie) =>
    cookie.startsWith(`${KORTIX_SUPABASE_AUTH_COOKIE}=`),
  )).toEqual([]);
}

describe('middleware leaves session refresh to the browser', () => {
  for (const [state, seconds] of [['stale', 30], ['expired', -60]] as const) {
    test(`${state} cookie: no client or auth reads, bounce retains the refresh credential`, async () => {
      const { request, value } = sessionRequest(seconds);
      const response = await middleware(request);

      expect(createServerClient).not.toHaveBeenCalled();
      expect(getClaims).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expectAuthBounce(response);
      expectRetained(request, value, response);
    });
  }

  test('fresh cookie resolves a verified live user and renders the protected route', async () => {
    const { request, value } = sessionRequest(3600);
    const response = await middleware(request);

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(getClaims).toHaveBeenCalledTimes(1);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    // The accepted user's verified profile, not the cookie, picks the locale.
    expect(new URL(response.headers.get('x-middleware-rewrite') ?? '').pathname).toBe('/de/workspaces');
    expectRetained(request, value, response);
  });

  for (const [code, message, clearsCookie] of [
    ['session_not_found', 'Session not found', true],
    ['bad_jwt', 'Invalid JWT: token is expired', false],
  ] as const) {
    test(`${code}: ${clearsCookie ? 'clears dead session' : 'retains refreshable expired JWT'}`, async () => {
      const { request, value } = sessionRequest(3600);
      getUser.mockResolvedValue({
        data: { user: null },
        error: Object.assign(new Error(message), { code, status: code === 'session_not_found' ? 403 : 401 }),
      });
      const response = await middleware(request);

      expect(createServerClient).toHaveBeenCalledTimes(1);
      expect(getClaims).toHaveBeenCalledTimes(1);
      expect(getUser).toHaveBeenCalledTimes(1);
      expectAuthBounce(response);
      if (clearsCookie) {
        const cleared = response.cookies.get(KORTIX_SUPABASE_AUTH_COOKIE);
        expect(cleared?.value).toBe('');
        // Cleared with Max-Age=0 and the cookie's own attributes, so a partitioned cookie goes too (#9745).
        expect(cleared?.maxAge).toBe(0);
      } else {
        expectRetained(request, value, response);
      }
    });
  }

  // KRTX-1978: a hover prefetch can be the request that clears a dead session.
  // The router drops that bounce, so the next click arrives with no session
  // cookie at all — and must still tell /auth the session ended.
  test('a navigation after a dropped self-heal response still says the session ended', async () => {
    const { request } = sessionRequest(3600);
    // What auth-js 2.x returns for GoTrue's `session_not_found`: it rethrows it
    // as AuthSessionMissingError (400, no code) and clears the cookie itself.
    getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('Auth session missing!'), {
        name: 'AuthSessionMissingError',
        status: 400,
      }),
    });
    const prefetch = await middleware(request);

    const next = new NextRequest('https://example.test/workspaces');
    for (const cookie of prefetch.cookies.getAll()) {
      if (cookie.value) next.cookies.set(cookie.name, cookie.value);
    }
    expect(next.cookies.has(KORTIX_SUPABASE_AUTH_COOKIE)).toBe(false);
    expectAuthBounce(await middleware(next));
  });
});

test('blocking maintenance redirects signed-in locale-prefixed app routes', async () => {
  const original = await getMaintenanceConfig();
  await setMaintenanceConfig({ ...original, level: 'blocking' }, 'synthetic-token');
  try {
    for (const path of ['/en/settings?tab=profile', '/fr/workspaces']) {
      const { request } = sessionRequest(3600);
      request.nextUrl.pathname = path.split('?')[0];
      request.nextUrl.search = path.includes('?') ? '?tab=profile' : '';
      const response = await middleware(request);
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.pathname).toBe('/maintenance');
      expect(location.searchParams.get('from')).toBe(path.slice(3));
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    }
  } finally {
    await setMaintenanceConfig(original, 'synthetic-token');
  }
});
