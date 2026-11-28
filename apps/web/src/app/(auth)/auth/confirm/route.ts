import { resolveAuthRedirectBaseUrl } from '@/lib/auth/return-url';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { NextRequest, NextResponse } from 'next/server';

/** Adapt GoTrue's fallback template without concatenating a callback query. */
export function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const target = URL.parse(query.get('redirect_to') ?? '');
  const tokenHash = query.get('token_hash');
  const origin = new URL(resolveAuthRedirectBaseUrl(request.nextUrl.origin, getServerPublicEnv().APP_URL));
  // SiteURL may name www while the originating browser uses the apex host.
  // This hop does not exchange credentials; the target callback owns cookies.
  const sameSite = target && target.protocol === origin.protocol && target.port === origin.port &&
    target.hostname.replace(/^www\./, '') === origin.hostname.replace(/^www\./, '');
  if (!sameSite || !target || !tokenHash || target.username || target.password || target.hash ||
      !['/auth/callback', '/auth/mobile/callback'].includes(target.pathname)) {
    return new NextResponse('Invalid signup confirmation target', { status: 400 });
  }
  target.searchParams.set('token_hash', tokenHash);
  target.searchParams.set('type', 'signup');
  return NextResponse.redirect(target, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
