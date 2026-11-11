/**
 * Google Antigravity OAuth credentials management and token auto-refresh.
 *
 * Stored format in ANTIGRAVITY_AUTH_JSON:
 * {
 *   "antigravity": {
 *     "type": "oauth",
 *     "access": "ya29...",
 *     "refresh": "1//...",
 *     "expires": 1234567890,
 *     "email": "user@example.com",
 *     "plan": "pro"
 *   }
 * }
 */

import { and, eq, sql } from 'drizzle-orm';
import { accountSecretResources, projectSecrets } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { encryptProjectSecret, resolveProjectSecretForConsumer } from '../../projects/secrets';
import { writeRotatedAccountLogin } from './rotating-login-write';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface StoredAntigravityAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  plan?: string;
}

export interface AntigravityCredential {
  access: string;
  email?: string;
  plan?: string;
}

export function parseAntigravityAuth(value: string): StoredAntigravityAuth | null {
  try {
    const parsed = JSON.parse(value);
    const auth = parsed.antigravity ?? parsed.google ?? parsed;
    if (auth && typeof auth === 'object') {
      return auth as StoredAntigravityAuth;
    }
    return null;
  } catch {
    return null;
  }
}

export function isTokenExpired(auth: StoredAntigravityAuth): boolean {
  if (!auth.expires) return false;
  return Date.now() + REFRESH_WINDOW_MS >= auth.expires;
}

/**
 * Refreshes an expired Google OAuth access token using its refresh token.
 */
export async function refreshAntigravityToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number; id_token?: string }> {
  const clientId = config.GOOGLE_ANTIGRAVITY_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_ANTIGRAVITY_CLIENT_SECRET || undefined;

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Google Antigravity token refresh failed (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!data.access_token) {
    throw new Error('Google did not return a refreshed access token');
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 3600,
    id_token: data.id_token,
  };
}

/**
 * Resolves a valid Google Antigravity credential for a project/session, auto-refreshing if expired.
 */
export async function resolveAntigravityCredential(
  projectId: string,
  userId: string,
): Promise<AntigravityCredential | null> {
  const secret = await resolveProjectSecretForConsumer(projectId, 'ANTIGRAVITY_AUTH_JSON', userId).catch(() => null);
  if (!secret) return null;

  const auth = parseAntigravityAuth(secret);
  if (!auth || !auth.access) return null;

  if (isTokenExpired(auth) && auth.refresh) {
    try {
      const refreshed = await refreshAntigravityToken(auth.refresh);
      const updatedAuth: StoredAntigravityAuth = {
        ...auth,
        access: refreshed.access_token,
        expires: Date.now() + refreshed.expires_in * 1000,
      };

      const updatedJson = JSON.stringify({ antigravity: updatedAuth }, null, 2);
      await encryptProjectSecret(projectId, 'ANTIGRAVITY_AUTH_JSON', updatedJson, { userId }).catch(() => {});

      return {
        access: updatedAuth.access!,
        email: updatedAuth.email,
        plan: updatedAuth.plan,
      };
    } catch {
      // If refresh fails temporarily, try using the existing access token
      return {
        access: auth.access,
        email: auth.email,
        plan: auth.plan,
      };
    }
  }

  return {
    access: auth.access,
    email: auth.email,
    plan: auth.plan,
  };
}
