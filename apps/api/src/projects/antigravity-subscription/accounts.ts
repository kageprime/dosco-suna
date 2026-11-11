/**
 * Google Antigravity accounts management.
 *
 * Tracks Antigravity credentials stored in account_secret_resources and project_secrets.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountSecretResources, projectSecrets } from '@kortix/db';
import { ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_PROVIDER_NAME } from '@kortix/api-contract/antigravity';
import { ANTIGRAVITY_AUTH_JSON_SECRET_NAME } from '../lib/serializers';
import { db } from '../../shared/db';
import { listUsableGatewaySecrets } from '../../secrets/account-resource';
import type { ProviderAccountKind } from '../../secrets/provider-accounts';

export const ANTIGRAVITY_ACCOUNT: ProviderAccountKind = {
  providerId: ANTIGRAVITY_PROVIDER_ID,
  name: ANTIGRAVITY_AUTH_JSON_SECRET_NAME,
  label: ANTIGRAVITY_PROVIDER_NAME,
};

/**
 * Counts the active, usable Antigravity subscription accounts available to the user in this project.
 */
export async function countUsableAntigravityAccounts(
  accountId: string,
  projectId: string,
  userId: string,
): Promise<number> {
  const rows = await listUsableGatewaySecrets({
    accountId,
    projectId,
    userId,
    providerId: ANTIGRAVITY_ACCOUNT.providerId,
    name: ANTIGRAVITY_ACCOUNT.name,
  }).catch(() => []);

  if (rows.length > 0) {
    const refused = await db
      .select({ secretId: accountSecretResources.secretId })
      .from(accountSecretResources)
      .where(
        and(
          eq(accountSecretResources.accountId, accountId),
          inArray(
            accountSecretResources.secretId,
            rows.map((row) => row.secretId),
          ),
          sql`${accountSecretResources.needsReauthAt} is not null`,
        ),
      )
      .catch(() => []);
    const usable = rows.length - refused.length;
    if (usable > 0) return usable;
  }

  // Fallback: check project_secrets for project-level credentials
  const projectRows = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, ANTIGRAVITY_ACCOUNT.name),
      ),
    )
    .catch(() => []);

  return projectRows.length;
}
