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
 *     "plan": "pro",
 *     "project": "aicode-consumers"
 *   }
 * }
 */

import { eq } from 'drizzle-orm';
import { accountSecretResources, projectSecrets } from '@kortix/db';
import {
  parseAntigravityAuth,
  type StoredAntigravityAuth,
} from '@kortix/api-contract/antigravity';
import { config } from '../../config';
import { db } from '../../shared/db';
import { resolveProjectSecretForConsumer, writeSharedProjectSecret } from '../../projects/secrets';
import { projectsView } from '../../workspaces/rows';
import { writeRotatedAccountLogin } from './rotating-login-write';
import { discoverAntigravityProject } from './antigravity-cloudcode';

export { parseAntigravityAuth, type StoredAntigravityAuth };

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Antigravity public installed-app client (also used by the Antigravity IDE).
// The client ID is public; the client SECRET is not committed — it comes from
// GOOGLE_ANTIGRAVITY_CLIENT_SECRET (encrypted env, Heroku config).
const DEFAULT_GOOGLE_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface AntigravityCredential {
  access: string;
  email?: string;
  plan?: string;
  project?: string;
  refresh?: string;
}

export function isTokenExpired(auth: StoredAntigravityAuth): boolean {
  if (!auth.expires) return !!auth.refresh;
  return Date.now() + REFRESH_WINDOW_MS >= auth.expires;
}

/**
 * Refreshes an expired Google OAuth access token using its refresh token.
 */
export async function refreshAntigravityToken(
  refreshToken: string,
  opts?: { clientId?: string; clientSecret?: string },
): Promise<{ access_token: string; expires_in: number; id_token?: string }> {
  const clientId = opts?.clientId || config.GOOGLE_ANTIGRAVITY_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  const clientSecret = opts?.clientSecret || config.GOOGLE_ANTIGRAVITY_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Google Antigravity is not configured: GOOGLE_ANTIGRAVITY_CLIENT_SECRET is missing',
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

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
      .select({ accountId: projectsView.accountId })
      .from(projectsView)
      .where(eq(projectsView.projectId, projectId))
      .limit(1)
      .catch(() => []);
    if (proj?.accountId) resolvedAccountId = proj.accountId;
  }

  const candidateNames = ['ANTIGRAVITY_AUTH_JSON', 'GOOGLE_ANTIGRAVITY_AUTH_JSON'];
  let rawSecret: string | null = null;
  let sourceSecretId: string | null = null;
  let sourceIsAccountResource = false;

  // 1. Check project secrets in parallel while preserving candidateNames precedence
  const projectResults = await Promise.all(
    candidateNames.map((name) =>
      resolveProjectSecretForConsumer({
        projectId,
        accountId: resolvedAccountId,
        sessionId,
        actorUserId: userId,
        principalUserId: userId,
        name,
        consumer: 'llm_gateway',
      }).catch(() => null),
    ),
  );
  const resolvedProject = projectResults.find((resolved) => Boolean(resolved?.value));
  if (resolvedProject?.value) {
    rawSecret = resolvedProject.value;
    sourceSecretId = resolvedProject.secretId;
  }

  // 2. If not found in project secrets, check account secret resources (personal default, then shared) in one wave
  if (!rawSecret && resolvedAccountId) {
    const { resolveDefaultProviderAccountSecret, resolveProjectSharedProviderSecrets } = await import(
      '../../secrets/account-resource'
    );

    const providerIds = ['antigravity', 'google'];
    const pairs = providerIds.flatMap((providerId) => candidateNames.map((name) => ({ providerId, name })));

    const [defaultResults, sharedResults] = await Promise.all([
      Promise.all(
        pairs.map(({ providerId, name }) =>
          resolveDefaultProviderAccountSecret(resolvedAccountId, projectId, userId, {
            providerId,
            name,
          }).catch(() => null),
        ),
      ),
      Promise.all(
        pairs.map(({ providerId, name }) =>
          resolveProjectSharedProviderSecrets({
            accountId: resolvedAccountId,
            projectId,
            userId,
            grantUserId: userId,
            sessionId,
            providerId,
            name,
          }).catch(() => null),
        ),
      ),
    ]);

    const acctSecret = defaultResults.find((secret) => Boolean(secret?.value));
    if (acctSecret?.value) {
      rawSecret = acctSecret.value;
      sourceSecretId = acctSecret.secretId;
      sourceIsAccountResource = true;
    } else {
      const sharedSecret = sharedResults.map((shared) => shared?.secrets?.[0]).find((secret) => Boolean(secret?.value));
      if (sharedSecret?.value) {
        rawSecret = sharedSecret.value;
        sourceSecretId = sharedSecret.secretId;
        sourceIsAccountResource = true;
      }
    }
  }

  if (!rawSecret) return null;

  const auth = parseAntigravityAuth(rawSecret);
  if (!auth || (!auth.access && !auth.refresh)) return null;

  const persistAuth = async (updatedAuth: StoredAntigravityAuth, usedRefresh?: string): Promise<void> => {
    const updatedJson = JSON.stringify({ antigravity: updatedAuth }, null, 2);
    if (sourceIsAccountResource && sourceSecretId) {
      if (!usedRefresh) return;
      await writeRotatedAccountLogin({
        secretId: sourceSecretId,
        usedRefresh,
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
  };

  if ((!auth.access || isTokenExpired(auth)) && auth.refresh) {
    try {
      const refreshed = await refreshAntigravityToken(auth.refresh, {
        clientId: auth.client_id,
        clientSecret: auth.client_secret,
      });
      const updatedAuth: StoredAntigravityAuth = {
        ...auth,
        access: refreshed.access_token,
        expires: Date.now() + refreshed.expires_in * 1000,
      };

      await persistAuth(updatedAuth, auth.refresh);

      let project = updatedAuth.project;
      if (!project && updatedAuth.access) {
        const access = updatedAuth.access;
        project = (await discoverAntigravityProject(access).catch(() => null)) ?? undefined;
        if (project) {
          updatedAuth.project = project;
          await persistAuth(updatedAuth, auth.refresh);
        }
      }

      return {
        access: updatedAuth.access!,
        email: updatedAuth.email,
        plan: updatedAuth.plan,
        project,
        refresh: updatedAuth.refresh,
      };
    } catch {
      // Only fall back to the existing access token when it exists and is still
      // genuinely unexpired (e.g. preemptive refresh hit a transient network hiccup).
      if (!auth.access || !auth.expires || Date.now() >= auth.expires) {
        return null;
      }
      let project = auth.project;
      if (!project && auth.access) {
        project = (await discoverAntigravityProject(auth.access).catch(() => null)) ?? undefined;
        if (project) {
          await persistAuth({ ...auth, project }, auth.refresh);
        }
      }
      return {
        access: auth.access,
        email: auth.email,
        plan: auth.plan,
        project,
        refresh: auth.refresh,
      };
    }
  }

  // An expired credential with no refresh token is a dead paste (a raw `ya29…`
  // bearer): report it as unavailable instead of sending Google a rejected call.
  if (!auth.access || isTokenExpired(auth)) return null;

  let project = auth.project;
  if (!project && auth.access) {
    project = (await discoverAntigravityProject(auth.access).catch(() => null)) ?? undefined;
    if (project) {
      await persistAuth({ ...auth, project }, auth.refresh);
    }
  }

  return {
    access: auth.access,
    email: auth.email,
    plan: auth.plan,
    project,
    refresh: auth.refresh,
  };
}
