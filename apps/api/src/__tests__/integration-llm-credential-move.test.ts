/**
 * Integration test (real local DB): the move of legacy LLM provider
 * credentials (`project_secrets`, consumer `llm_gateway`) into the named store
 * (`account_secret_resources`), secrets/llm-credential-move.ts.
 *
 * It proves, against real SQL and real envelopes:
 *   - each legacy shape lands where the mapping table says, with the same value;
 *   - a moved row is never read again by the legacy readers, and the one key
 *     reader (credentials/gateway-keys.ts) still finds the key;
 *   - a re-run is idempotent, a later legacy write re-copies, and a named
 *     account deleted in the Models panel stays deleted;
 *   - rows a named account cannot express stay legacy and stay readable;
 *   - a dry run writes nothing;
 *   - the old `/secrets` write and delete reach only the named store.
 *
 * Fully isolated: one fresh account and project, synthetic members and values.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountSecretGrants, accountSecretResources, llmCredentialBackfill, projectMembers, projectSecrets, roleAssignments } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { encryptProjectSecret, listProjectSecretNamesForConsumer, resolveProjectSecretsForConsumer } from '../projects/secrets';
import { setSecretAudience } from '../projects/lib/secret-audience';
import { decryptAccountSecret, encryptAccountSecret } from '../secrets/account-resource';
import {
  backfillLegacyLlmCredentials,
  deleteWorkspaceProviderKeys,
  llmCredentialTargetOf,
  moveLegacyLlmCredential,
  writeWorkspaceProviderKey,
} from '../secrets/llm-credential-move';
import { connectedGatewayKeyNames, resolveGatewayKeyValues } from '../llm-gateway/credentials/gateway-keys';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const TEAMMATE = crypto.randomUUID();
/** Not an account member. */
const LEAVER = crypto.randomUUID();
const CUSTOM_ID = 'acme-llm';

let project: SeededProject;
let accountId: string;
let projectId: string;

async function legacy(name: string, value: string, over: Partial<typeof projectSecrets.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(projectSecrets).values({
    projectId, identifier: over.identifier ?? name, name, valueEnc: encryptProjectSecret(projectId, value),
    strategy: 'broker', consumer: 'llm_gateway', createdBy: OWNER, ...over,
  }).returning({ secretId: projectSecrets.secretId });
  return row!.secretId;
}

async function named(secretId: string) {
  const [row] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, secretId));
  return row ?? null;
}

async function ledgerOf(legacySecretId: string) {
  const [row] = await db.select().from(llmCredentialBackfill).where(eq(llmCredentialBackfill.legacySecretId, legacySecretId));
  return row ?? null;
}

const legacyValues = (name: string, principalUserId: string | null = null) => resolveProjectSecretsForConsumer({
  projectId, accountId, actorUserId: OWNER, principalUserId, name, consumer: 'llm_gateway', probe: true,
});

beforeAll(async () => {
  project = await seedProject('llm-credential-move', {
    metadata: { custom_llm_providers: [{ id: CUSTOM_ID, name: 'Acme', base_url: 'https://llm.example.test/v1', models: [{ id: 'm1', name: 'M1' }] }] },
  });
  accountId = project.account_id;
  projectId = project.project_id;
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId, accountRole: 'owner', isSuperAdmin: false },
    { userId: TEAMMATE, accountId, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId, projectId, userId: OWNER, projectRole: 'manager' },
    { accountId, projectId, userId: TEAMMATE, projectRole: 'member' },
  ]);
});

afterAll(async () => {
  await removeSeeded([project]);
});

describe('the name mapping', () => {
  test('a catalog key, a ChatGPT login, Bedrock region, a custom key, and an unread name', () => {
    expect(llmCredentialTargetOf('OPENAI_API_KEY', [])).toEqual({ providerId: 'openai', kind: 'key' });
    expect(llmCredentialTargetOf('AWS_BEARER_TOKEN_BEDROCK', [])).toEqual({ providerId: 'amazon-bedrock', kind: 'key' });
    expect(llmCredentialTargetOf('CODEX_AUTH_JSON', [])).toEqual({ providerId: 'codex', kind: 'login' });
    expect(llmCredentialTargetOf('AWS_REGION', [])).toEqual({ providerId: 'amazon-bedrock', kind: 'setting' });
    expect(llmCredentialTargetOf('CUSTOM_ACME_LLM_API_KEY', [CUSTOM_ID])).toEqual({ providerId: CUSTOM_ID, kind: 'key' });
    // A custom key whose provider was deleted, and a name no reader reads.
    expect(llmCredentialTargetOf('CUSTOM_GONE_API_KEY', [CUSTOM_ID])).toBeNull();
    expect(llmCredentialTargetOf('AZURE_RESOURCE_NAME', [])).toBeNull();
  });
});

describe('a shared key', () => {
  let legacyId: string;
  let namedId: string;

  test('a dry run plans the copy and writes nothing', async () => {
    legacyId = await legacy('OPENAI_API_KEY', 'sk-synthetic-openai-1');
    const plan = await moveLegacyLlmCredential(legacyId, { apply: false });
    expect(plan?.outcome).toBe('copied');
    expect(await ledgerOf(legacyId)).toBeNull();
    const rows = await db.select().from(accountSecretResources).where(eq(accountSecretResources.accountId, accountId));
    expect(rows).toHaveLength(0);
  });

  test('is copied as a workspace key with the same value, and the legacy readers stop reading it', async () => {
    expect((await legacyValues('OPENAI_API_KEY')).map((v) => v.value)).toEqual(['sk-synthetic-openai-1']);
    const moved = await moveLegacyLlmCredential(legacyId, { apply: true });
    expect(moved?.outcome).toBe('copied');
    namedId = moved!.accountSecretId!;
    const row = await named(namedId);
    expect(row).toMatchObject({ projectId, accessMode: 'project', label: 'Workspace key', providerId: 'openai', name: 'OPENAI_API_KEY', createdBy: OWNER, consumer: 'llm_gateway' });
    expect(decryptAccountSecret(accountId, row!.valueEnc)).toBe('sk-synthetic-openai-1');
    expect((await ledgerOf(legacyId))?.outcome).toBe('copied');

    // The gate: the legacy row is still there, and no legacy reader sees it.
    expect(await legacyValues('OPENAI_API_KEY')).toEqual([]);
    expect(await listProjectSecretNamesForConsumer({ projectId, consumer: 'llm_gateway' })).not.toContain('OPENAI_API_KEY');
  });

  test('the one key reader serves the named key to a member', async () => {
    const scope = { accountId, projectId, userId: TEAMMATE, grantUserId: TEAMMATE };
    expect(await connectedGatewayKeyNames(scope)).toContain('OPENAI_API_KEY');
    const values = await resolveGatewayKeyValues({ ...scope, providerId: 'openai', name: 'OPENAI_API_KEY', probe: true });
    expect(values.store).toBe('named');
    expect(values.keys.map((k) => [k.secretId, k.value])).toEqual([[namedId, 'sk-synthetic-openai-1']]);
  });

  test('a re-run is unchanged and makes no second account', async () => {
    const summary = await backfillLegacyLlmCredentials({ apply: true, projectId });
    expect(summary.results.find((r) => r.legacySecretId === legacyId)?.outcome).toBe('unchanged');
    const rows = await db.select().from(accountSecretResources)
      .where(and(eq(accountSecretResources.accountId, accountId), eq(accountSecretResources.name, 'OPENAI_API_KEY')));
    expect(rows).toHaveLength(1);
  });

  test('a later legacy write is copied into the same named account', async () => {
    await db.update(projectSecrets).set({ valueEnc: encryptProjectSecret(projectId, 'sk-synthetic-openai-2'), updatedAt: new Date(Date.now() + 1000) })
      .where(eq(projectSecrets.secretId, legacyId));
    expect((await moveLegacyLlmCredential(legacyId, { apply: true }))?.outcome).toBe('recopied');
    expect(decryptAccountSecret(accountId, (await named(namedId))!.valueEnc)).toBe('sk-synthetic-openai-2');
    expect((await moveLegacyLlmCredential(legacyId, { apply: true }))?.outcome).toBe('unchanged');
  });

  test('a named account deleted in the Models panel stays deleted, and the legacy value stays unread', async () => {
    await db.delete(accountSecretResources).where(eq(accountSecretResources.secretId, namedId));
    await db.update(projectSecrets).set({ updatedAt: new Date(Date.now() + 2000) }).where(eq(projectSecrets.secretId, legacyId));
    expect((await moveLegacyLlmCredential(legacyId, { apply: true }))?.outcome).toBe('unchanged');
    expect(await named(namedId)).toBeNull();
    expect(await legacyValues('OPENAI_API_KEY')).toEqual([]);
    const values = await resolveGatewayKeyValues({ accountId, projectId, userId: OWNER, grantUserId: OWNER, providerId: 'openai', name: 'OPENAI_API_KEY', probe: true });
    expect(values.keys).toEqual([]);
  });
});

describe('each legacy shape', () => {
  test('a personal ChatGPT login becomes the owner\'s own members-only account', async () => {
    const id = await legacy('CODEX_AUTH_JSON', '{"openai":{"access":"synthetic"}}', { ownerUserId: TEAMMATE, createdBy: TEAMMATE });
    const moved = await moveLegacyLlmCredential(id, { apply: true });
    expect(moved?.outcome).toBe('copied');
    expect(await named(moved!.accountSecretId!)).toMatchObject({ accessMode: 'members', providerId: 'codex', createdBy: TEAMMATE, label: 'ChatGPT' });
    const grants = await db.select({ userId: accountSecretGrants.userId }).from(accountSecretGrants).where(eq(accountSecretGrants.secretId, moved!.accountSecretId!));
    expect(grants.map((g) => g.userId)).toEqual([TEAMMATE]);
  });

  test('a personal override of someone who left the account stays legacy and readable', async () => {
    const id = await legacy('CODEX_AUTH_JSON', '{"openai":{"access":"leaver"}}', { ownerUserId: LEAVER, createdBy: LEAVER });
    expect((await moveLegacyLlmCredential(id, { apply: true }))?.outcome).toBe('skipped_no_owner');
    expect((await legacyValues('CODEX_AUTH_JSON', LEAVER)).map((v) => v.value)).toEqual(['{"openai":{"access":"leaver"}}']);
  });

  test('Bedrock region and a custom provider key land under their provider', async () => {
    const region = await moveLegacyLlmCredential(await legacy('AWS_REGION', 'eu-west-1'), { apply: true });
    expect(await named(region!.accountSecretId!)).toMatchObject({ providerId: 'amazon-bedrock', name: 'AWS_REGION', label: 'Bedrock region', accessMode: 'project' });
    const custom = await moveLegacyLlmCredential(await legacy('CUSTOM_ACME_LLM_API_KEY', 'synthetic-custom'), { apply: true });
    expect(await named(custom!.accountSecretId!)).toMatchObject({ providerId: CUSTOM_ID, name: 'CUSTOM_ACME_LLM_API_KEY' });
  });

  test('a name no reader reads is skipped and recorded', async () => {
    const id = await legacy('AZURE_RESOURCE_NAME', 'synthetic-resource');
    expect((await moveLegacyLlmCredential(id, { apply: true }))?.outcome).toBe('skipped_unread');
    expect((await ledgerOf(id))?.outcome).toBe('skipped_unread');
  });

  test('a value already in the Models panel is not copied twice', async () => {
    const [existing] = await db.insert(accountSecretResources).values({
      accountId, projectId, label: 'Mine', accessMode: 'members', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY',
      valueEnc: encryptAccountSecret(accountId, 'sk-ant-synthetic'), consumer: 'llm_gateway', strategy: 'broker', createdBy: OWNER,
    }).returning({ secretId: accountSecretResources.secretId });
    const id = await legacy('ANTHROPIC_API_KEY', 'sk-ant-synthetic');
    const moved = await moveLegacyLlmCredential(id, { apply: true });
    expect(moved).toMatchObject({ outcome: 'already_present', accountSecretId: existing!.secretId });
    const rows = await db.select().from(accountSecretResources).where(eq(accountSecretResources.name, 'ANTHROPIC_API_KEY'));
    expect(rows.filter((r) => r.accountId === accountId)).toHaveLength(1);
  });

  test('a value narrowed to people becomes a members-only account granted to them', async () => {
    const id = await legacy('GROQ_API_KEY', 'gsk-synthetic');
    await setSecretAudience({ accountId, projectId, secretId: id, principals: [{ principal_type: 'user', principal_id: TEAMMATE }], grantedBy: OWNER });
    const moved = await moveLegacyLlmCredential(id, { apply: true });
    expect(moved?.outcome).toBe('copied');
    expect((await named(moved!.accountSecretId!))?.accessMode).toBe('members');
    const grants = await db.select({ userId: accountSecretGrants.userId }).from(accountSecretGrants).where(eq(accountSecretGrants.secretId, moved!.accountSecretId!));
    expect(grants.map((g) => g.userId).sort()).toEqual([OWNER, TEAMMATE].sort());
  });

  test('a value narrowed to an agent stays legacy and readable', async () => {
    const id = await legacy('MISTRAL_API_KEY', 'mistral-synthetic');
    await setSecretAudience({ accountId, projectId, secretId: id, principals: [{ principal_type: 'user', principal_id: OWNER }], grantedBy: OWNER });
    const [grant] = await db.select().from(roleAssignments).where(and(eq(roleAssignments.objectType, 'secret'), eq(roleAssignments.objectId, id)));
    await db.update(roleAssignments).set({ principalType: 'service_account', principalId: crypto.randomUUID() })
      .where(eq(roleAssignments.assignmentId, grant!.assignmentId));
    expect((await moveLegacyLlmCredential(id, { apply: true }))?.outcome).toBe('skipped_audience');
    expect((await ledgerOf(id))?.outcome).toBe('skipped_audience');
  });

  test('a value this API cannot decrypt stays legacy and is recorded', async () => {
    const id = await legacy('DEEPSEEK_API_KEY', 'x', { valueEnc: 'not-an-envelope' });
    expect((await moveLegacyLlmCredential(id, { apply: true }))?.outcome).toBe('failed_undecryptable');
  });
});

describe('the old /secrets write path', () => {
  test('writes the workspace key, updates it in place, supersedes the legacy row, and deletes it', async () => {
    const legacyId = await legacy('XAI_API_KEY', 'xai-legacy');
    const first = await writeWorkspaceProviderKey({ accountId, projectId, userId: OWNER, name: 'XAI_API_KEY', value: 'xai-1' });
    expect(first).toMatchObject({ providerId: 'xai', created: true });
    const second = await writeWorkspaceProviderKey({ accountId, projectId, userId: OWNER, name: 'xai_api_key', value: 'xai-2' });
    expect(second).toMatchObject({ secretId: first!.secretId, created: false });
    expect(decryptAccountSecret(accountId, (await named(first!.secretId))!.valueEnc)).toBe('xai-2');
    expect((await ledgerOf(legacyId))?.outcome).toBe('superseded');
    expect(await legacyValues('XAI_API_KEY')).toEqual([]);
    // No project secret row was written for the name.
    const legacyRows = await db.select().from(projectSecrets).where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, 'XAI_API_KEY')));
    expect(legacyRows.map((r) => r.secretId)).toEqual([legacyId]);

    expect(await deleteWorkspaceProviderKeys({ accountId, projectId, name: 'XAI_API_KEY' })).toBe(1);
    expect(await named(first!.secretId)).toBeNull();
  });

  test('a name no reader reads, and a ChatGPT login, are not redirected', async () => {
    expect(await writeWorkspaceProviderKey({ accountId, projectId, userId: OWNER, name: 'AZURE_RESOURCE_NAME', value: 'x' })).toBeNull();
    expect(await writeWorkspaceProviderKey({ accountId, projectId, userId: OWNER, name: 'CODEX_AUTH_JSON', value: '{}' })).toBeNull();
  });
});
