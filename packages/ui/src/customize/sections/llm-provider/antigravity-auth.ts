export interface StoredAntigravityAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  plan?: string;
}

/**
 * Parses raw Antigravity auth input. Supports:
 * 1. Raw bearer token or API key (`ya29...`, `AIzaSy...`, `Bearer ...`)
 * 2. Google OAuth credentials JSON (`~/.gemini/oauth_creds.json`: `access_token`, `refresh_token`, `expiry_date`)
 * 3. Wrapped Antigravity JSON (`{ antigravity: { access, refresh, expires } }`)
 */
export function parseAntigravityAuth(value: string | null | undefined): StoredAntigravityAuth | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Handle raw token or key (non-JSON) directly
  if (!trimmed.startsWith('{')) {
    return {
      type: 'bearer',
      access: trimmed.replace(/^Bearer\s+/i, ''),
      expires: Date.now() + 365 * 24 * 3600 * 1000,
    };
  }

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

      if (access || refresh) {
        return {
          type: auth.type ?? 'oauth',
          access,
          refresh,
          expires,
          email,
          plan,
        };
      }
    }
    return null;
  } catch {
    return {
      type: 'bearer',
      access: trimmed.replace(/^Bearer\s+/i, ''),
      expires: Date.now() + 365 * 24 * 3600 * 1000,
    };
  }
}
