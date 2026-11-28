import { createHash } from 'node:crypto';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { buildMobileBounceHtml } from '@/lib/auth/desktop-bounce';
import { createClient } from '@/lib/supabase/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function authError(request: NextRequest, message: string): NextResponse {
  const url = new URL('/auth', request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}

/**
 * Browser-owned callback for registration started by the native app.
 * The browser exchanges the PKCE code using its cookie-held verifier (or
 * verifies the signup token hash the confirmation email carries), then returns
 * the resulting session to the app through the existing state-validated deep
 * link. This path is deliberately outside the universal-link matcher.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state');
  const code = searchParams.get('code');
  // The signup confirmation links here with a token hash instead of a PKCE
  // code: GoTrue expires a signup code 5 minutes after the signup started,
  // the token hash lives as long as the email's OTP.
  const signupTokenHash =
    searchParams.get('type') === 'signup' ? searchParams.get('token_hash') : null;

  if (searchParams.get('mobile_callback') !== '1' || !state) {
    return authError(request, 'invalid_mobile_callback');
  }

  // The emailed hash is a bearer credential. A scanner holding only the URL
  // must not exchange it for the session rendered into the native handoff.
  if (signupTokenHash) {
    const binder = request.cookies.get(`${KORTIX_SUPABASE_AUTH_COOKIE}-mobile-signup`)?.value;
    const digest = searchParams.get('browser_binding');
    if (!binder || !digest || createHash('sha256').update(binder).digest('hex') !== digest) {
      return authError(request, 'invalid_mobile_callback');
    }
  }

  const supabase = await createClient();
  const exchange = signupTokenHash
    ? supabase.auth.verifyOtp({ token_hash: signupTokenHash, type: 'signup' })
    : code
      ? supabase.auth.exchangeCodeForSession(code)
      : null;
  if (!exchange) {
    return authError(request, searchParams.get('error') || 'missing_auth_code');
  }

  const { data, error } = await exchange;
  if (error || !data.session?.access_token || !data.session.refresh_token) {
    return authError(request, error?.message || 'auth_exchange_failed');
  }

  const handoffParams = new URLSearchParams();
  handoffParams.set('mobile_callback', '1');
  handoffParams.set('state', state);
  handoffParams.set('access_token', data.session.access_token);
  handoffParams.set('refresh_token', data.session.refresh_token);
  for (const key of ['terms_accepted', 'returnUrl']) {
    const value = searchParams.get(key);
    if (value) handoffParams.set(key, value);
  }

  return new NextResponse(buildMobileBounceHtml(handoffParams), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
