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
import { accountSecretResources, projectSecrets, projects } from '@kortix/db';
import {
  parseAntigravityAuth,
  type StoredAntigravityAuth,
} from '@kortix/api-contract/antigravity';
import { config } from '../../config';
import { db } from '../../shared/db';
import { resolveProjectSecretForConsumer, writeSharedProjectSecret } from '../../projects/secrets';
import { writeRotatedAccountLogin } from './rotating-login-write';

export { parseAntigravityAuth, type StoredAntigravityAuth };

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface AntigravityCredential {
  access: string;
  email?: string;
  plan?: string;
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
  accountId?: string,
  sessionId?: string | null,
): Promise<AntigravityCredential | null> {
  // If accountId is not provided, look it up from the project
  let resolvedAccountId = accountId;
  if (!resolvedAccountId) {
    const [proj] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1)
      .catch(() => []);
    if (proj?.accountId) resolvedAccountId = proj.accountId;
  }

  const candidateNames = ['ANTIGRAVITY_AUTH_JSON', 'GOOGLE_ANTIGRAVITY_AUTH_JSON', 'GEMINI_API_KEY'];
  let rawSecret: string | null = null;
  let sourceSecretId: string | null = null;
  let sourceIsAccountResource = false;

  // 1. Check project secrets
  for (const name of candidateNames) {
    const resolved = await resolveProjectSecretForConsumer({
      projectId,
      accountId: resolvedAccountId,
      sessionId,
      actorUserId: userId,
      principalUserId: userId,
      name,
      consumer: 'llm_gateway',
    }).catch(() => null);

    if (resolved?.value) {
      rawSecret = resolved.value;
      sourceSecretId = resolved.secretId;
      break;
    }
  }

  // 2. If not found in project secrets, check account secret resources
  if (!rawSecret && resolvedAccountId) {
    const { resolveDefaultProviderAccountSecret, resolveProjectSharedProviderSecrets } = await import(
      '../../secrets/account-resource'
    );

    const providerIds = ['antigravity', 'google'];

    // Check personal default account secret
    for (const providerId of providerIds) {
      for (const name of candidateNames) {
        const acctSecret = await resolveDefaultProviderAccountSecret(resolvedAccountId, projectId, userId, {
          providerId,
          name,
        }).catch(() => null);
        if (acctSecret?.value) {
          rawSecret = acctSecret.value;
          sourceSecretId = acctSecret.secretId;
          sourceIsAccountResource = true;
          break;
        }
      }
      if (rawSecret) break;
    }

    // Check project shared provider secrets
    if (!rawSecret) {
      for (const providerId of providerIds) {
        for (const name of candidateNames) {
          const shared = await resolveProjectSharedProviderSecrets({
            accountId: resolvedAccountId,
            projectId,
            userId,
            grantUserId: userId,
            sessionId,
            providerId,
            name,
          }).catch(() => null);
          const secret = shared?.secrets?.[0];
          if (secret?.value) {
            rawSecret = secret.value;
            sourceSecretId = secret.secretId;
            sourceIsAccountResource = true;
            break;
          }
        }
        if (rawSecret) break;
      }
    }
  }

  if (!rawSecret) return null;

  const auth = parseAntigravityAuth(rawSecret);
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
      if (sourceIsAccountResource && sourceSecretId) {
        await writeRotatedAccountLogin({
          secretId: sourceSecretId,
          usedRefresh: auth.refresh,
          refreshOf: (plaintext) => parseAntigravityAuth(plaintext)?.refresh,
          value: updatedJson,
        }).catch(() => {});
      } else {
        await writeSharedProjectSecret({
          projectId,
          name: 'ANTIGRAVITY_AUTH_JSON',
          value: updatedJson,
          createdBy: userId,
        }).catch(() => {});
      }

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
