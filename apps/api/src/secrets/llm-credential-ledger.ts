/**
 * The read gate of the LLM credential move (`llm-credential-move.ts`), kept
 * free of the gateway and catalog imports so the legacy secret readers
 * (`projects/secrets/consumer-resolution.ts`) can apply it without a cycle.
 */
import { accountSecretResources, llmCredentialBackfill, projectSecrets } from '@kortix/db';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { db } from '../shared/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Outcomes after which a legacy `llm_gateway` secret is never read again. */
export const LLM_CREDENTIAL_MOVED_OUTCOMES = ['copied', 'already_present', 'superseded'] as const;

/**
 * SQL for "this legacy `project_secrets` row has not moved to the named
 * store": every legacy `llm_gateway` read ANDs it in. A moved row's named
 * account serves instead, and deleting that account in the Models panel does
 * not bring the old value back.
 */
export function legacySecretNotMoved(secretId: SQL | typeof projectSecrets.secretId = projectSecrets.secretId): SQL {
  return sql`not exists (select 1 from ${llmCredentialBackfill} where ${llmCredentialBackfill.legacySecretId} = ${secretId} and ${llmCredentialBackfill.outcome} in (${sql.join(LLM_CREDENTIAL_MOVED_OUTCOMES.map((o) => sql`${o}`), sql`, `)}))`;
}

/**
 * SQL for a reader of `project_secrets` rows of every consumer (session env,
 * the secrets list): keep a row unless it is an `llm_gateway` row that has
 * moved to the named store. A moved row is never decrypted or listed again.
 */
export function projectSecretRowNotMoved(): SQL {
  return sql`(${projectSecrets.consumer} is distinct from 'llm_gateway' or ${legacySecretNotMoved(projectSecrets.secretId)})`;
}

/**
 * The legacy rows `legacySecretIds` were deleted (the old `DELETE /oauth`):
 * delete the named accounts the backfill created from them (`copied`), so a
 * disconnect from an old client disconnects the login it sees. A named
 * account that existed before (`already_present`) or that a person made
 * stays. Runs in the caller's transaction. Returns how many were deleted.
 */
export async function deleteNamedCopiesOfLegacySecrets(tx: Tx, accountId: string, legacySecretIds: string[]): Promise<number> {
  if (!legacySecretIds.length) return 0;
  const copies = await tx.select({ accountSecretId: llmCredentialBackfill.accountSecretId }).from(llmCredentialBackfill).where(and(
    inArray(llmCredentialBackfill.legacySecretId, legacySecretIds),
    eq(llmCredentialBackfill.outcome, 'copied'),
    eq(llmCredentialBackfill.accountId, accountId),
  ));
  const ids = copies.flatMap((row) => (row.accountSecretId ? [row.accountSecretId] : []));
  if (!ids.length) return 0;
  const removed = await tx.delete(accountSecretResources)
    .where(and(eq(accountSecretResources.accountId, accountId), inArray(accountSecretResources.secretId, ids)))
    .returning({ secretId: accountSecretResources.secretId });
  return removed.length;
}
