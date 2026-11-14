/**
 * The one public redirect URI Dosco registers with third-party authorization
 * servers. It is derived from the PUBLIC API origin (`KORTIX_URL`), never from
 * the incoming request: behind the load balancer the API sees
 * `http://<internal-host>/…`, and an authorization server rejects a redirect_uri
 * that does not byte-match the registered one.
 */
export const NATIVE_OAUTH2_CALLBACK_PATH = '/v1/connectors/oauth2/callback';

function publicApiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const pathname = url.pathname
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function nativeOAuth2CallbackUrl(
  requestUrl: string,
  publicApiUrl: string | undefined,
): string {
  const base = publicApiOrigin(publicApiUrl);
  if (base) return `${base}${NATIVE_OAUTH2_CALLBACK_PATH}`;
  return new URL(NATIVE_OAUTH2_CALLBACK_PATH, requestUrl).href;
}

/** The connector a sign-in was for, as the return page shows it. */
export interface SignInConnector {
  name: string;
  /** `apps/web/public/connector-icons/<slug>.svg`, when Kortix ships one. */
  iconSlug: string | null;
}

/** The web page a sign-in with no return page of its own lands on. */
export const SIGN_IN_RETURN_PATH = '/connect/done';

const CALLBACK_ERROR_HINTS: Record<string, string> = {
  invalid_state: 'this sign-in link was already used or has expired. Start the sign-in again.',
};

function frontendOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * What the public callback answers. Every browser leaves on a Dosco page:
 * the return page the sign-in was started with, or else the web's
 * `/connect/done`, which names the connector and closes a sign-in window.
 * A sign-in started by an agent's raw link or the CLI has no return page, and
 * used to end on a plain-text API response. Plain text remains only for a
 * deployment with no web app URL.
 */
export function nativeOAuth2CallbackResponse(
  result: {
    ok: boolean;
    redirectUri: string | null;
    errorCode?: string;
    connector?: SignInConnector | null;
  },
  frontendUrl?: string,
): { status: 200 | 400; body: string } | { status: 302; location: string } {
  if (result.redirectUri) {
    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set('oauth2', result.ok ? 'connected' : 'error');
    if (result.errorCode) redirect.searchParams.set('oauth2_error', result.errorCode);
    return { status: 302, location: redirect.href };
  }
  const web = frontendOrigin(frontendUrl);
  if (web) {
    const page = new URL(`${web}${SIGN_IN_RETURN_PATH}`);
    page.searchParams.set('oauth2', result.ok ? 'connected' : 'error');
    if (result.errorCode) page.searchParams.set('oauth2_error', result.errorCode);
    if (result.connector?.name) page.searchParams.set('app', result.connector.name.slice(0, 80));
    if (result.connector?.iconSlug) page.searchParams.set('icon', result.connector.iconSlug);
    return { status: 302, location: page.href };
  }
  if (result.ok) {
    return { status: 200, body: 'Connected. You can close this tab and return to Dosco.' };
  }
  const code = result.errorCode ?? 'authorization_failed';
  const hint = CALLBACK_ERROR_HINTS[code];
  return {
    status: 400,
    body: `OAuth2 authorization failed (${code})${hint ? `: ${hint}` : '.'}`,
  };
}
