import { memoInRequest } from '../shared/request-memo';
import { accountSecretResources, projectLlmRoutingPolicies, projectSecrets } from '@kortix/db';
import { legacySecretNotMoved } from '../secrets/llm-credential-ledger';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { modelAccessAllows, readModelAccess, updateModelAccess, type ModelAccessChange } from '../llm-gateway/model-access';
import {
  CUSTOM_PROVIDERS_METADATA_KEY,
  type CustomLlmProviderDefinition,
  type CustomLlmProviderInput,
  readCustomProviders,
  upsertCustomProvider,
} from '../llm-gateway/custom-providers';
import { projectsView, updateProjectRows } from '../workspaces/rows';

/** The transaction handle a `db.transaction` callback receives. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One plain metadata read: the select and its not-found throw. */
async function readProjectMetadata(projectId: string): Promise<unknown> {
  const [row] = await db.select({ metadata: projectsView.metadata }).from(projectsView)
    .where(eq(projectsView.projectId, projectId)).limit(1);
  if (!row) throw new Error('Project not found');
  return row.metadata;
}

/** One row-locked metadata read (`FOR UPDATE`), inside `db.transaction`. */
async function lockProjectMetadata(tx: Tx, projectId: string): Promise<unknown> {
  const [row] = await tx.select({ metadata: projectsView.metadata }).from(projectsView)
    .where(eq(projectsView.projectId, projectId)).for('update');
  if (!row) throw new Error('Project not found');
  return row.metadata;
}

export async function getProjectModelAccess(projectId: string) {
  return readModelAccess(await readProjectMetadata(projectId));
}

/** Read model access, the pooled flag and custom providers from one projects row (KRTX-586). */
export function getProjectGatewayResolution(projectId: string) {
  // Shared within one request: gateway admission prefetches it.
  return memoInRequest(`gateway-resolution:${projectId}`, () => readProjectGatewayResolution(projectId));
}

async function readProjectGatewayResolution(projectId: string) {
  const metadata = await readProjectMetadata(projectId);
  return {
    access: readModelAccess(metadata),
    pooledEnabled: resolveFeatureFlag(metadata, 'pooled_provider_secrets'),
    customProviders: readCustomProviders(metadata),
  };
}

/** Row locking prevents two switches from replacing each other's changes. */
export async function changeProjectModelAccess(input: {
  projectId: string;
  updatedBy: string;
  defaultModel: string | undefined;
  change: ModelAccessChange;
}) {
  return db.transaction(async (tx) => {
    const metadata = await lockProjectMetadata(tx, input.projectId);
    const policy = updateModelAccess(readModelAccess(metadata), input.change);
    if (!input.change.enabled && input.defaultModel && !modelAccessAllows(policy, input.defaultModel)) {
      return { conflict: true as const };
    }
    await updateProjectRows(eq(projectsView.projectId, input.projectId), {
      metadata: sql`jsonb_set(coalesce(${projectsView.metadata}, '{}'::jsonb), '{model_access}', ${JSON.stringify(policy)}::jsonb)`,
      updatedAt: new Date(),
    }, tx);
    // Enabling a model also makes it visible, including an older catalog model.
    // Other display preferences survive this single-model update.
    if (input.change.target === 'model' && input.change.enabled) {
      const override = { [input.change.id]: true };
      await tx.insert(projectLlmRoutingPolicies).values({
        projectId: input.projectId, modelOverrides: override, updatedBy: input.updatedBy,
      }).onConflictDoUpdate({
        target: projectLlmRoutingPolicies.projectId,
        set: { modelOverrides: sql`${projectLlmRoutingPolicies.modelOverrides} || ${JSON.stringify(override)}::jsonb`,
          updatedBy: input.updatedBy, updatedAt: new Date() },
      });
    }
    return { conflict: false as const, policy };
  });
}

/** The project's custom providers and the names of its project-wide `CUSTOM_*_API_KEY` secrets. */
export async function listProjectCustomProviders(projectId: string) {
  const [[row], secrets, named] = await Promise.all([
    db.select({ metadata: projectsView.metadata }).from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1),
    // Legacy keys the backfill has not moved yet (llm-credential-move.ts).
    db.select({ name: projectSecrets.name }).from(projectSecrets).where(and(
      eq(projectSecrets.projectId, projectId),
      isNull(projectSecrets.ownerUserId),
      like(projectSecrets.name, 'CUSTOM\\_%\\_API\\_KEY'),
      legacySecretNotMoved(projectSecrets.secretId),
    )),
    // Named keys: where every write goes now.
    db.select({ name: accountSecretResources.name }).from(accountSecretResources).where(and(
      eq(accountSecretResources.projectId, projectId),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.active, true),
      like(accountSecretResources.name, 'CUSTOM\\_%\\_API\\_KEY'),
    )),
  ]);
  const secretNames = [...new Set([...secrets, ...named].map((secret) => secret.name))];
  return { providers: readCustomProviders(row?.metadata), secretNames };
}

/**
 * Create, replace (`input`) or remove (`null`) one custom provider. Row-locked
 * like `changeProjectModelAccess`, so two writes never drop each other's entry.
 * Returns null when removing an id that does not exist.
 */
export async function writeProjectCustomProvider(
  projectId: string,
  id: string,
  input: CustomLlmProviderInput | null,
  detected?: Parameters<typeof upsertCustomProvider>[3],
): Promise<CustomLlmProviderDefinition[] | null> {
  return db.transaction(async (tx) => {
    const metadata = await lockProjectMetadata(tx, projectId);
    const current = readCustomProviders(metadata);
    if (!input && !current.some((provider) => provider.id === id)) return null;
    const next = input ? upsertCustomProvider(current, id, input, detected) : current.filter((provider) => provider.id !== id);
    await updateProjectRows(eq(projectsView.projectId, projectId), {
      metadata: sql`jsonb_set(coalesce(${projectsView.metadata}, '{}'::jsonb), ${`{${CUSTOM_PROVIDERS_METADATA_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    }, tx);
    return next;
  });
}
