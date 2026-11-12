/**
 * The legacy credential moves that are not LLM provider keys (those are
 * `llm-credential-move.ts`). Each concept moves a legacy row to its canonical
 * form in place, and records the columns it changed in
 * `kortix.legacy_credential_backfill`:
 *
 *   | concept                     | legacy row                                    | canonical form                    |
 *   |-----------------------------|-----------------------------------------------|-----------------------------------|
 *   | `connector_secret_strategy` | `project_secrets` consumer `connector`,       | strategy `broker` (what every     |
 *   |                             | strategy `runtime` (stamped by the            | connector and channel write makes |
 *   |                             | 2026-07-12 and 2026-08-05 migrations)         | since 2026-08-05)                 |
 *   | `connector_secret_consumer` | `project_secrets` scope `connector`, consumer | consumer `connector`, strategy    |
 *   |                             | `sandbox` (scope set, consumer not)           | `broker`                          |
 *   | `external_connection`       | `connector_connections` owner type `external` | revoked: the owner type retired   |
 *   |                             | (pre-account email inboxes, and per-end-user  | on 2026-10-24 and nobody can      |
 *   |                             | connections of the retired SDK mode)          | reach the row                     |
 *
 * Why in place: both legacy forms are already read by the canonical readers
 * (`consumer-resolution.ts` `secretPolicyAllowsConsumer` accepts a connector
 * row of any strategy; `connection-access.ts` reaches no `external` row), so
 * the move changes nothing a user sees. It lets the follow-up delete the
 * legacy branches of those readers.
 *
 * The operator script is `apps/api/scripts/legacy-credential-backfill.ts`.
 * Dry run by default; idempotent; deletes nothing; never reads a value.
 */
import { connectorConnections, legacyCredentialBackfill, projectSecrets } from '@kortix/db';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { revokeConnections } from '../connectors/connection-status';

export const LEGACY_CREDENTIAL_CONCEPTS = ['connector_secret_strategy', 'connector_secret_consumer', 'external_connection'] as const;
export type LegacyCredentialConcept = (typeof LEGACY_CREDENTIAL_CONCEPTS)[number];

export type LegacyCredentialOutcome = 'moved' | 'would_move' | 'skipped_changed';

export interface LegacyCredentialResult {
  concept: LegacyCredentialConcept;
  objectId: string;
  projectId: string;
  outcome: LegacyCredentialOutcome;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function record(tx: Tx, concept: LegacyCredentialConcept, objectId: string, projectId: string, before: Record<string, unknown>, detail?: string) {
  const values = { concept, objectId, projectId, outcome: 'moved', before, detail: detail ?? null, updatedAt: new Date() };
  await tx.insert(legacyCredentialBackfill).values(values)
    .onConflictDoUpdate({ target: [legacyCredentialBackfill.concept, legacyCredentialBackfill.objectId], set: values });
}

/** Legacy connector secret rows, oldest id first, after `after`. */
async function connectorSecretPage(projectId: string | undefined, after: string | null, limit: number) {
  return db.select({ objectId: projectSecrets.secretId, projectId: projectSecrets.projectId }).from(projectSecrets)
    .where(and(
      eq(projectSecrets.consumer, 'connector'), eq(projectSecrets.strategy, 'runtime'),
      ...(projectId ? [eq(projectSecrets.projectId, projectId)] : []),
      ...(after ? [gt(projectSecrets.secretId, after)] : []),
    )).orderBy(asc(projectSecrets.secretId)).limit(limit);
}

/** Connector-scope secret rows stamped consumer `sandbox`. */
async function connectorConsumerPage(projectId: string | undefined, after: string | null, limit: number) {
  return db.select({ objectId: projectSecrets.secretId, projectId: projectSecrets.projectId }).from(projectSecrets)
    .where(and(
      eq(projectSecrets.scope, 'connector'), eq(projectSecrets.consumer, 'sandbox'),
      ...(projectId ? [eq(projectSecrets.projectId, projectId)] : []),
      ...(after ? [gt(projectSecrets.secretId, after)] : []),
    )).orderBy(asc(projectSecrets.secretId)).limit(limit);
}

async function externalConnectionPage(projectId: string | undefined, after: string | null, limit: number) {
  return db.select({ objectId: connectorConnections.connectionId, projectId: connectorConnections.projectId }).from(connectorConnections)
    .where(and(
      eq(connectorConnections.ownerType, 'external'), ne(connectorConnections.status, 'revoked'),
      ...(projectId ? [eq(connectorConnections.projectId, projectId)] : []),
      ...(after ? [gt(connectorConnections.connectionId, after)] : []),
    )).orderBy(asc(connectorConnections.connectionId)).limit(limit);
}

/** Move one connector secret row to strategy `broker`. Its value and `updated_at` do not change. */
async function moveConnectorSecret(objectId: string, apply: boolean): Promise<LegacyCredentialOutcome> {
  if (!apply) return 'would_move';
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ projectId: projectSecrets.projectId, strategy: projectSecrets.strategy, strategyLocked: projectSecrets.strategyLocked })
      .from(projectSecrets).where(and(eq(projectSecrets.secretId, objectId), eq(projectSecrets.consumer, 'connector'))).limit(1).for('update');
    if (!row || row.strategy !== 'runtime') return 'skipped_changed';
    await tx.update(projectSecrets).set({ strategy: 'broker' }).where(eq(projectSecrets.secretId, objectId));
    await record(tx, 'connector_secret_strategy', objectId, row.projectId, { strategy: row.strategy, strategy_locked: row.strategyLocked });
    return 'moved';
  });
}

/**
 * Move one connector-scope row stamped consumer `sandbox` to consumer
 * `connector`, strategy `broker`. It is never delivered to a sandbox either way
 * (session env reads scope `runtime` only); only connector readers read it.
 */
async function moveConnectorConsumer(objectId: string, apply: boolean): Promise<LegacyCredentialOutcome> {
  if (!apply) return 'would_move';
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ projectId: projectSecrets.projectId, strategy: projectSecrets.strategy, consumer: projectSecrets.consumer, scope: projectSecrets.scope })
      .from(projectSecrets).where(eq(projectSecrets.secretId, objectId)).limit(1).for('update');
    if (!row || row.scope !== 'connector' || row.consumer !== 'sandbox') return 'skipped_changed';
    await tx.update(projectSecrets).set({ consumer: 'connector', strategy: 'broker' }).where(eq(projectSecrets.secretId, objectId));
    await record(tx, 'connector_secret_consumer', objectId, row.projectId, { consumer: row.consumer, strategy: row.strategy });
    return 'moved';
  });
}

/** Revoke one connection of the retired `external` owner type. */
async function moveExternalConnection(objectId: string, apply: boolean): Promise<LegacyCredentialOutcome> {
  if (!apply) return 'would_move';
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ projectId: connectorConnections.projectId, status: connectorConnections.status, isDefault: connectorConnections.isDefault })
      .from(connectorConnections).where(and(eq(connectorConnections.connectionId, objectId), eq(connectorConnections.ownerType, 'external'))).limit(1).for('update');
    if (!row || row.status === 'revoked') return 'skipped_changed';
    const revoked = await revokeConnections(
      and(eq(connectorConnections.connectionId, objectId), eq(connectorConnections.ownerType, 'external')),
      { set: { isDefault: false }, metadata: { revokedBy: 'legacy_credential_backfill' } },
      tx,
    );
    if (!revoked.length) return 'skipped_changed';
    await record(tx, 'external_connection', objectId, row.projectId, { status: row.status, is_default: row.isDefault }, 'owner type external retired');
    return 'moved';
  });
}

export interface LegacyCredentialBackfillSummary {
  /** Per concept: outcome → count. */
  outcomes: Record<LegacyCredentialConcept, Record<string, number>>;
  /** Rows of each concept the ledger already holds as moved (earlier runs). */
  ledger: Record<LegacyCredentialConcept, number>;
}

/**
 * Run every concept (or `concepts`) over every legacy row (or one project's).
 * Each row is its own transaction. A dry run writes nothing and reports
 * `would_move` per row.
 */
export async function backfillLegacyCredentials(options: {
  apply: boolean;
  projectId?: string;
  concepts?: readonly LegacyCredentialConcept[];
  pageSize?: number;
  onResult?: (result: LegacyCredentialResult) => void;
}): Promise<LegacyCredentialBackfillSummary> {
  const pageSize = options.pageSize ?? 200;
  const concepts = options.concepts ?? LEGACY_CREDENTIAL_CONCEPTS;
  const summary: LegacyCredentialBackfillSummary = {
    outcomes: { connector_secret_strategy: {}, connector_secret_consumer: {}, external_connection: {} },
    ledger: { connector_secret_strategy: 0, connector_secret_consumer: 0, external_connection: 0 },
  };
  for (const concept of concepts) {
    const page = { connector_secret_strategy: connectorSecretPage, connector_secret_consumer: connectorConsumerPage, external_connection: externalConnectionPage }[concept];
    const move = { connector_secret_strategy: moveConnectorSecret, connector_secret_consumer: moveConnectorConsumer, external_connection: moveExternalConnection }[concept];
    let after: string | null = null;
    for (;;) {
      const rows: Array<{ objectId: string; projectId: string }> = await page(options.projectId, after, pageSize);
      if (!rows.length) break;
      for (const row of rows) {
        const outcome = await move(row.objectId, options.apply);
        summary.outcomes[concept][outcome] = (summary.outcomes[concept][outcome] ?? 0) + 1;
        options.onResult?.({ concept, objectId: row.objectId, projectId: row.projectId, outcome });
      }
      after = rows[rows.length - 1]!.objectId;
    }
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(legacyCredentialBackfill).where(and(
      eq(legacyCredentialBackfill.concept, concept), eq(legacyCredentialBackfill.outcome, 'moved'),
      ...(options.projectId ? [eq(legacyCredentialBackfill.projectId, options.projectId)] : []),
    ));
    summary.ledger[concept] = count?.n ?? 0;
  }
  return summary;
}
