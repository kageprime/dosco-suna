import { getEnv } from '@/lib/env-config';

/**
 * Scope the local-dev auth cookie to the actual frontend port so running
 * multiple local frontends on the same host (localhost:3000, localhost:13737)
 * does not cause cross-app Supabase sign-out/session churn.
 *
 * Browsers scope cookies by host, not port. If two local apps on localhost use
 * the same cookie name and the same Supabase project, auth operations in one
 * app can overwrite or clear the other's session cookie.
 */
function resolveAuthCookieName() {
  // Resolve through the RUNTIME env reader, not a raw process.env read. A
  // raw read makes the browser bundle's name depend on whatever APP_URL was
  // inlined at BUILD time, while the server's runtime env can name a
  // different origin: a mismatch seeds the PKCE verifier cookie under a name
  // the /auth/callback exchange never reads, and every fresh email-link
  // signup dies on "The link is invalid or expired" (KRTX-4628).
  // getEnv() prefers `window.__KORTIX_RUNTIME_CONFIG` in the browser and
  // process.env on the server, so both sides compute the SAME name.
  let appUrl: string | undefined;
  try {
    appUrl = getEnv().APP_URL;
  } catch {
    // getEnv() throws when required runtime env is absent (bare unit-test
    // process, page-data collection). Keep the historical precedence so the
    // module never throws at import time.
    appUrl =
      process.env.KORTIX_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_URL ||
      process.env.PUBLIC_URL;
  }

  if (!appUrl) return 'sb-kortix-auth-token';

  try {
    const url = new URL(appUrl);
    const isLocalhost = ['localhost', '127.0.0.1'].includes(url.hostname);
    const port = url.port;

    if (isLocalhost && port) {
      return `sb-kortix-auth-token-${port}`;
    }
  } catch {
    // Fall back to the historical cookie name.
  }

  return 'sb-kortix-auth-token';
}

export const KORTIX_SUPABASE_AUTH_COOKIE = resolveAuthCookieName();
