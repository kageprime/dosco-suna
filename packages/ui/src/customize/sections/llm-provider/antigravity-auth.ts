export interface StoredAntigravityAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  plan?: string;
  /** Cloud Code companion project the subscription bills through. */
  project?: string;
}

/**
 * Epoch ms an access-only (bearer) paste stays usable. Mirrors
 * `@kortix/api-contract/antigravity`: Google access tokens live about an hour,
 * and a paste without a refresh token cannot be refreshed.
 */
const BEARER_ACCESS_TTL_MS = 50 * 60 * 1000;

/**
 * Parses raw Antigravity auth input. Supports:
 * 1. Google OAuth credentials JSON (`~/.gemini/oauth_creds.json`: `access_token`, `refresh_token`, `expiry_date`)
 * 2. Wrapped Antigravity JSON (`{ antigravity: { access, refresh, expires, project } }`)
 * 3. A raw `ya29…` bearer access token (usable for ~50 min, never refreshed)
 *
 * Anything else — API keys (`AIza…`), arbitrary garbage — is rejected with
 * `null`. This mirrors `parseAntigravityAuth` in the API contract so the UI
 * never accepts a value the server will reject.
 */
export function parseAntigravityAuth(value: string | null | undefined): StoredAntigravityAuth | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const auth = parsed.antigravity ?? parsed.google ?? parsed;
      if (auth && typeof auth === 'object') {
        const access = (auth.access ?? auth.access_token)?.toString().trim();
        const refresh = (auth.refresh ?? auth.refresh_token)?.toString().trim();
        const expires =
          typeof auth.expires === 'number'
            ? auth.expires
            : typeof auth.expiry_date === 'number'
              ? auth.expiry_date
              : undefined;
        const email = auth.email ?? auth.id_token_email;
        const plan = auth.plan;
        const project = typeof auth.project === 'string' ? auth.project : undefined;

        if (access || refresh) {
          return {
            type: auth.type ?? 'oauth',
            access,
            refresh,
            expires,
            email,
            plan,
            project,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  const raw = trimmed.replace(/^Bearer\s+/i, '').trim();
  if (/^ya29[.\-_A-Za-z0-9]/.test(raw) && raw.length >= 25) {
    return { type: 'bearer', access: raw, expires: Date.now() + BEARER_ACCESS_TTL_MS };
  }
  return null;
}