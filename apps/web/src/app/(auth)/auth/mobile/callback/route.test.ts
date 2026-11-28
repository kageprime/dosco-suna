import { beforeEach, expect, mock, test } from 'bun:test';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

// Only the Supabase transport is replaced; the route's branching runs for real.
mock.module('server-only', () => ({}));
type AuthResult = {
  data: { session: { access_token: string; refresh_token: string } | null };
  error: { message: string } | null;
};
const session = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' };
const verifyOtp = mock(
  async (_args: unknown): Promise<AuthResult> => ({ data: { session }, error: null }),
);
const exchangeCodeForSession = mock(
  async (_code: string): Promise<AuthResult> => ({ data: { session }, error: null }),
);
mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { verifyOtp, exchangeCodeForSession } }),
}));
const { GET } = await import('./route');
const binder = 'synthetic-browser-secret';
const digest = createHash('sha256').update(binder).digest('hex');
const request = (query: string, cookie: string | null = binder) =>
  new NextRequest(
    `http://localhost:13000/auth/mobile/callback?mobile_callback=1&state=synthetic-state&browser_binding=${digest}&${query}`,
    { headers: cookie ? { cookie: `${KORTIX_SUPABASE_AUTH_COOKIE}-mobile-signup=${cookie}` } : {} },
  );
const errorOf = (response: Response) =>
  new URL(response.headers.get('location') ?? '').searchParams.get('error');

beforeEach(() => {
  verifyOtp.mockClear();
  exchangeCodeForSession.mockClear();
});

test('a signup token hash is verified and the session bounces to the app', async () => {
  const response = await GET(
    request('token_hash=synthetic-hash&type=signup&returnUrl=/workspaces/start'),
  );
  expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'synthetic-hash', type: 'signup' });
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
  expect(response.headers.get('content-type')).toContain('text/html');
  const html = await response.text();
  expect(html).toContain('synthetic-access');
  expect(html).toContain('synthetic-state');
});

test('a PKCE code still exchanges', async () => {
  const response = await GET(request('code=synthetic-code'));
  expect(exchangeCodeForSession).toHaveBeenCalledWith('synthetic-code');
  expect(verifyOtp).not.toHaveBeenCalled();
  expect(await response.text()).toContain('synthetic-access');
});

test('a token hash of another type is not verified', async () => {
  const response = await GET(request('token_hash=synthetic-hash&type=recovery'));
  expect(verifyOtp).not.toHaveBeenCalled();
  expect(errorOf(response)).toBe('missing_auth_code');
});

test('a failed verification returns to /auth with the error', async () => {
  verifyOtp.mockImplementationOnce(async () => ({
    data: { session: null },
    error: { message: 'Email link is invalid or has expired' },
  }));
  const response = await GET(request('token_hash=synthetic-hash&type=signup'));
  expect(errorOf(response)).toBe('Email link is invalid or has expired');
});

test('without the mobile state nothing is verified', async () => {
  const response = await GET(
    new NextRequest(
      'http://localhost:13000/auth/mobile/callback?token_hash=synthetic-hash&type=signup',
    ),
  );
  expect(verifyOtp).not.toHaveBeenCalled();
  expect(errorOf(response)).toBe('invalid_mobile_callback');
});

for (const cookie of [null, 'different-browser-secret']) {
  test(`a signup link without its originating browser is rejected (${cookie === null ? 'absent' : 'mismatch'})`, async () => {
    const response = await GET(request('token_hash=synthetic-hash&type=signup', cookie));
    expect(errorOf(response)).toBe('invalid_mobile_callback');
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('synthetic-access');
  });
}
test('a signup link without its binding digest is rejected', async () => {
  const response = await GET(
    new NextRequest(
      'http://localhost:13000/auth/mobile/callback?mobile_callback=1&state=synthetic-state&token_hash=synthetic-hash&type=signup',
      { headers: { cookie: `${KORTIX_SUPABASE_AUTH_COOKIE}-mobile-signup=${binder}` } },
    ),
  );
  expect(errorOf(response)).toBe('invalid_mobile_callback');
  expect(verifyOtp).not.toHaveBeenCalled();
});
