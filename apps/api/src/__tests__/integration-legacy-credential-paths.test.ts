/**
 * Integration test (real local DB): every legacy credential path works for a
 * user who has only legacy data, until the follow-up removes it, and every
 * reader stops reading a legacy row once it moved.
 *
 *   - LLM provider keys (`project_secrets`, consumer `llm_gateway`): the
 *     session env, the secrets list, the OpenCode Console refresh, the old
 *     `DELETE /oauth/{provider}` and the old `POST /secrets` / setup-link
 *     writes honor the move ledger (`llm_credential_backfill`).
 *   - Connector secrets with the legacy strategy `runtime`, and connections of
 *     the retired `external` owner type: the backfill in
 *     `secrets/legacy-credential-backfill.ts` (dry run, apply, re-run).
 *
 * Fully isolated: fresh accounts and projects, synthetic members and values.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  accountMembers, accountSecretResources, connectorConnections, connectors, legacyCredentialBackfill,
  llmCredentialBackfill, projectMembers, projectSecrets,
} from '@kortix/db';
import { db } from '../shared/db';
import { encryptProjectSecret, listResolvedProjectSecrets, resolveProjectSecretForConsumer } from '../projects/secrets';
import { loadSecretViewsForUser } from '../projects/lib/serializers';
import { decryptAccountSecret } from '../secrets/account-resource';
import { backfillLegacyLlmCredentials, moveLegacyLlmCredential } from '../secrets/llm-credential-move';
import { backfillLegacyCredentials } from '../secrets/legacy-credential-backfill';
import { runLegacyCredentialBackfills } from '../secrets/legacy-credential-boot';
import { resolveGatewayKeyValues } from '../llm-gateway/credentials/gateway-keys';
import { refreshRefusedOpencodeLogin } from '../llm-gateway/credentials/opencode-console';
import { resolveCodexCredential } from '../llm-gateway/credentials/codex';
import { mintSetupLink } from '../setup-links/token';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const { projectsApp } = await import('../projects/lib/app');
const { setupLinksPublicApp } = await import('../setup-links/public-app');
(await import('../projects/routes/secrets')).registerSecretsRoutes();
(await import('../projects/routes/provider-oauth')).registerProviderOauthRoutes();

const OWNER = crypto.randomUUID();
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, OWNER as never);
  c.set('authType' as never, 'supabase' as never);
  c.set('mfaAal' as never, 'aal2' as never);
  await next();
});
app.route('/v1/projects', projectsApp);

let project: SeededProject;
let other: SeededProject;
let accountId: string;
let projectId: string;

const login = (access: string) => JSON.stringify({ openai: { type: 'oauth', access, refresh: `${access}-refresh`, expires: Date.now() + 3_600_000 } });

async function legacy(name: string, value: string, over: Partial<typeof projectSecrets.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(projectSecrets).values({
    projectId, identifier: over.identifier ?? name, name, valueEnc: encryptProjectSecret(projectId, value),
    strategy: 'broker', consumer: 'llm_gateway', createdBy: OWNER, ...over,
  }).returning({ secretId: projectSecrets.secretId });
  return row!.secretId;
}

/** Mark a legacy row as moved without copying it (an undecryptable value cannot be copied). */
async function markMoved(legacySecretId: string, name: string) {
  await db.insert(llmCredentialBackfill).values({
    legacySecretId, projectId, accountId, name, outcome: 'copied', legacyUpdatedAt: new Date(),
  });
}

const scope = () => ({ accountId, projectId, userId: OWNER, grantUserId: OWNER });

beforeAll(async () => {
  project = await seedProject('legacy-credential-paths');
  other = await seedProject('legacy-credential-paths-other');
  accountId = project.account_id;
  projectId = project.project_id;
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId, accountRole: 'owner', isSuperAdmin: false });
  await insertIntoView(db, projectMembers, { accountId, projectId, userId: OWNER, projectRole: 'manager' });
});

afterAll(async () => {
  await removeSeeded([other, project]);
});

describe('a provider key a user has only as a legacy row', () => {
  test('serves from the legacy row before the backfill and from the named account after it', async () => {
    await legacy('GROQ_API_KEY', 'groq-legacy-only');
    const before = await resolveGatewayKeyValues({ ...scope(), providerId: 'groq', name: 'GROQ_API_KEY', probe: true });
    expect(before).toMatchObject({ store: 'legacy', keys: [{ value: 'groq-legacy-only' }] });

    await backfillLegacyLlmCredentials({ apply: true, projectId });
    const after = await resolveGatewayKeyValues({ ...scope(), providerId: 'groq', name: 'GROQ_API_KEY', probe: true });
    expect(after).toMatchObject({ store: 'named', keys: [{ value: 'groq-legacy-only' }] });
  });

  test('a ChatGPT login resolves from the legacy row until it moves, then only from its named account', async () => {
    const id = await legacy('CODEX_AUTH_JSON', login('codex-legacy-access'), { identifier: `CODEX_AUTH_JSON:${OWNER}`, ownerUserId: OWNER });
    const before = await resolveCodexCredential(projectId, OWNER, () => Promise.reject(new Error('no network in this test')), { accountId });
    expect(before?.access).toBe('codex-legacy-access');

    const moved = await moveLegacyLlmCredential(id, { apply: true });
    expect(moved?.outcome).toBe('copied');
    const [copy] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, moved!.accountSecretId!));
    expect(copy).toMatchObject({ providerId: 'codex', accessMode: 'members', createdBy: OWNER });
    expect(JSON.parse(decryptAccountSecret(accountId, copy!.valueEnc)).openai.access).toBe('codex-legacy-access');
    expect(await resolveCodexCredential(projectId, OWNER, () => Promise.reject(new Error('no network')), { accountId })).toBeNull();
  });
});

describe('readers outside the gateway honor the move ledger', () => {
  test('the session env skips a moved row it cannot decrypt, and still lists an unmoved one', async () => {
    const moved = await legacy('MISTRAL_API_KEY', 'x', { valueEnc: 'not-an-envelope' });
    await markMoved(moved, 'MISTRAL_API_KEY');
    await legacy('CEREBRAS_API_KEY', 'cerebras-unmoved');
    await db.insert(projectSecrets).values({
      projectId, identifier: 'APP_TOKEN', name: 'APP_TOKEN', valueEnc: encryptProjectSecret(projectId, 'app-value'),
      strategy: 'runtime', consumer: 'sandbox', createdBy: OWNER,
    });

    const rows = await listResolvedProjectSecrets(projectId, OWNER);
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    expect(byKey.has('MISTRAL_API_KEY')).toBe(false);
    expect(byKey.get('CEREBRAS_API_KEY')).toBe('cerebras-unmoved');
    expect(byKey.get('APP_TOKEN')).toBe('app-value');
  });

  test('the secrets list hides a moved row and keeps an unmoved one', async () => {
    const views = await loadSecretViewsForUser({ projectId, userId: OWNER, canManageShared: true });
    const names = views.map((view) => view.name);
    expect(names).not.toContain('MISTRAL_API_KEY');
    expect(names).toContain('CEREBRAS_API_KEY');
    expect(names).toContain('APP_TOKEN');
  });

  test('an OpenCode Console refresh reads a legacy login only while it has not moved', async () => {
    const value = JSON.stringify({ type: 'oauth', access: 'oc-access', refresh: 'oc-refresh', expires: Date.now() + 3_600_000 });
    const id = await legacy('OPENCODE_API_KEY', value);
    const input = { accountId, projectId, secretId: id, userId: OWNER, sessionId: null, failedKeySha256: 'another-key' };
    // Another request already replaced the refused key: the stored login comes back, no network.
    expect((await refreshRefusedOpencodeLogin(input, () => Promise.reject(new Error('no network'))))?.access).toBe('oc-access');
    await markMoved(id, 'OPENCODE_API_KEY');
    expect(await refreshRefusedOpencodeLogin(input, () => Promise.reject(new Error('no network')))).toBeNull();
  });
});

describe('old write and disconnect routes reach the named store', () => {
  test('POST /secrets with no consumer to an existing provider key row writes the named account', async () => {
    const legacyId = await legacy('FIREWORKS_API_KEY', 'fw-legacy');
    const res = await app.request(`/v1/projects/${projectId}/secrets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'FIREWORKS_API_KEY', value: 'fw-new' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ stored_in: 'provider_account', consumer: 'llm_gateway' });
    const [named] = await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, body.secret_resource_id as string));
    expect(decryptAccountSecret(accountId, named!.valueEnc)).toBe('fw-new');
    const [row] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, legacyId));
    // The legacy row is superseded, not rewritten.
    expect(row!.valueEnc).not.toBe(encryptProjectSecret(projectId, 'fw-new'));
    const [ledger] = await db.select().from(llmCredentialBackfill).where(eq(llmCredentialBackfill.legacySecretId, legacyId));
    expect(ledger?.outcome).toBe('superseded');
    const keys = await resolveGatewayKeyValues({ ...scope(), providerId: 'fireworks-ai', name: 'FIREWORKS_API_KEY', probe: true });
    expect(keys).toMatchObject({ store: 'named', keys: [{ value: 'fw-new' }] });
  });

  test('POST /secrets with no consumer to an ordinary secret still writes the project secret', async () => {
    const res = await app.request(`/v1/projects/${projectId}/secrets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'APP_TOKEN', value: 'app-value-2' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).stored_in).toBeUndefined();
  });

  test('a setup link that asks for an existing provider key writes its named account', async () => {
    const legacyId = await legacy('XAI_API_KEY', 'xai-legacy');
    const { token } = mintSetupLink(projectId, { kind: 'secret', fields: [{ name: 'XAI_API_KEY' }], scope: 'runtime', uid: OWNER, sid: null });
    const res = await setupLinksPublicApp.request(`/secret/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { XAI_API_KEY: 'xai-new' } }),
    });
    expect(res.status).toBe(200);
    const keys = await resolveGatewayKeyValues({ ...scope(), providerId: 'xai', name: 'XAI_API_KEY', probe: true });
    expect(keys).toMatchObject({ store: 'named', keys: [{ value: 'xai-new' }] });
    const [ledger] = await db.select().from(llmCredentialBackfill).where(eq(llmCredentialBackfill.legacySecretId, legacyId));
    expect(ledger?.outcome).toBe('superseded');

    // The link is single-use: a replay of the same token writes nothing.
    const replay = await setupLinksPublicApp.request(`/secret/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { XAI_API_KEY: 'xai-replayed' } }),
    });
    expect(replay.status).toBe(409);
    const after = await resolveGatewayKeyValues({ ...scope(), providerId: 'xai', name: 'XAI_API_KEY', probe: true });
    expect(after).toMatchObject({ store: 'named', keys: [{ value: 'xai-new' }] });
  });

  test('DELETE /oauth/openai disconnects the named copy the backfill made, and leaves a key a person added', async () => {
    const id = await legacy('CODEX_AUTH_JSON', login('codex-shared-access'));
    const moved = await moveLegacyLlmCredential(id, { apply: true });
    expect(moved?.outcome).toBe('copied');
    const [personAdded] = await db.insert(accountSecretResources).values({
      accountId, projectId, accessMode: 'project', label: 'My ChatGPT', providerId: 'codex', name: 'CODEX_AUTH_JSON',
      valueEnc: moved ? (await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, moved.accountSecretId!)))[0]!.valueEnc : '',
      consumer: 'llm_gateway', strategy: 'broker', createdBy: OWNER,
    }).returning({ secretId: accountSecretResources.secretId });

    const res = await app.request(`/v1/projects/${projectId}/oauth/openai`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, moved!.accountSecretId!))).toEqual([]);
    expect(await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, id))).toEqual([]);
    expect((await db.select().from(accountSecretResources).where(eq(accountSecretResources.secretId, personAdded!.secretId))).length).toBe(1);
  });
});

describe('connector credentials in a legacy form', () => {
  let connectorId: string;
  let runtimeSecretId: string;
  let sandboxStampedId: string;
  let externalId: string;
  let projectOwnedId: string;

  beforeAll(async () => {
    const [connector] = await db.insert(connectors).values({
      accountId, projectId, slug: 'legacy-paths-http', name: 'Legacy paths', providerType: 'http',
    }).returning({ connectorId: connectors.connectorId });
    connectorId = connector!.connectorId;
    // The shape the 2026-07-12 / 2026-08-05 migrations left: consumer connector, strategy runtime.
    const [secret] = await db.insert(projectSecrets).values({
      projectId, identifier: 'LEGACY_BOT_TOKEN', name: 'LEGACY_BOT_TOKEN', valueEnc: encryptProjectSecret(projectId, 'bot-token'),
      scope: 'connector', strategy: 'runtime', consumer: 'connector', createdBy: OWNER,
    }).returning({ secretId: projectSecrets.secretId, updatedAt: projectSecrets.updatedAt });
    runtimeSecretId = secret!.secretId;
    // A connector-scope row stamped consumer `sandbox` (written 2026-08-17 shape).
    const [sandboxStamped] = await db.insert(projectSecrets).values({
      projectId, identifier: 'LEGACY_SIGNING_SECRET', name: 'LEGACY_SIGNING_SECRET', valueEnc: encryptProjectSecret(projectId, 'signing-secret'),
      scope: 'connector', strategy: 'runtime', consumer: 'sandbox', createdBy: OWNER,
    }).returning({ secretId: projectSecrets.secretId });
    sandboxStampedId = sandboxStamped!.secretId;
    const [external] = await db.insert(connectorConnections).values({
      accountId, projectId, connectorId, ownerType: 'external', ownerId: 'agentmail:synthetic-inbox', label: 'Legacy inbox', status: 'active', isDefault: true,
    }).returning({ connectionId: connectorConnections.connectionId });
    externalId = external!.connectionId;
    const [owned] = await db.insert(connectorConnections).values({
      accountId, projectId, connectorId, ownerType: 'project', label: 'Shared', status: 'active',
    }).returning({ connectionId: connectorConnections.connectionId });
    projectOwnedId = owned!.connectionId;
  });

  const connectorValue = () => resolveProjectSecretForConsumer({
    projectId, accountId, actorUserId: OWNER, principalUserId: null, name: 'LEGACY_BOT_TOKEN', consumer: 'connector', probe: true,
  });

  test('a legacy runtime-strategy connector secret, and a sandbox-stamped one, resolve for their connector', async () => {
    expect((await connectorValue())?.value).toBe('bot-token');
    expect((await resolveProjectSecretForConsumer({
      projectId, accountId, actorUserId: OWNER, principalUserId: null, name: 'LEGACY_SIGNING_SECRET', consumer: 'connector', probe: true,
    }))?.value).toBe('signing-secret');
  });

  test('a dry run reports both moves and writes nothing', async () => {
    const summary = await backfillLegacyCredentials({ apply: false, projectId });
    expect(summary.outcomes).toEqual({ connector_secret_strategy: { would_move: 1 }, connector_secret_consumer: { would_move: 1 }, external_connection: { would_move: 1 } });
    const [secret] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, runtimeSecretId));
    expect(secret!.strategy).toBe('runtime');
    expect(await db.select().from(legacyCredentialBackfill).where(eq(legacyCredentialBackfill.projectId, projectId))).toEqual([]);
  });

  test('apply moves the secret to broker, revokes the external connection, records both, and touches nothing else', async () => {
    const [before] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, runtimeSecretId));
    const summary = await backfillLegacyCredentials({ apply: true, projectId });
    expect(summary.outcomes).toEqual({ connector_secret_strategy: { moved: 1 }, connector_secret_consumer: { moved: 1 }, external_connection: { moved: 1 } });
    const [stamped] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, sandboxStampedId));
    expect(stamped).toMatchObject({ scope: 'connector', consumer: 'connector', strategy: 'broker' });
    const signing = await resolveProjectSecretForConsumer({
      projectId, accountId, actorUserId: OWNER, principalUserId: null, name: 'LEGACY_SIGNING_SECRET', consumer: 'connector', probe: true,
    });
    expect(signing?.value).toBe('signing-secret');

    const [secret] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, runtimeSecretId));
    expect(secret).toMatchObject({ strategy: 'broker', consumer: 'connector', scope: 'connector', valueEnc: before!.valueEnc });
    expect(secret!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect((await connectorValue())?.value).toBe('bot-token');

    const [external] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, externalId));
    expect(external).toMatchObject({ status: 'revoked', isDefault: false });
    const [owned] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, projectOwnedId));
    expect(owned!.status).toBe('active');

    const ledger = await db.select().from(legacyCredentialBackfill).where(eq(legacyCredentialBackfill.projectId, projectId));
    expect(ledger.map((row) => [row.concept, row.objectId, row.outcome, row.before]).sort()).toEqual([
      ['connector_secret_consumer', sandboxStampedId, 'moved', { consumer: 'sandbox', strategy: 'runtime' }],
      ['connector_secret_strategy', runtimeSecretId, 'moved', { strategy: 'runtime', strategy_locked: false }],
      ['external_connection', externalId, 'moved', { status: 'active', is_default: true }],
    ]);
  });

  test('a re-run finds nothing to move and keeps the ledger', async () => {
    const summary = await backfillLegacyCredentials({ apply: true, projectId });
    expect(summary.outcomes).toEqual({ connector_secret_strategy: {}, connector_secret_consumer: {}, external_connection: {} });
    expect(summary.ledger).toEqual({ connector_secret_strategy: 1, connector_secret_consumer: 1, external_connection: 1 });
  });

  test('a run scoped to another project touches nothing here', async () => {
    const [extra] = await db.insert(connectorConnections).values({
      accountId, projectId, connectorId, ownerType: 'external', ownerId: 'synthetic-end-user', label: 'Another', status: 'active',
    }).returning({ connectionId: connectorConnections.connectionId });
    await backfillLegacyCredentials({ apply: true, projectId: other.project_id });
    const [row] = await db.select().from(connectorConnections).where(and(eq(connectorConnections.connectionId, extra!.connectionId)));
    expect(row!.status).toBe('active');
  });
});

describe('the self-host boot run of both backfills', () => {
  test('off moves nothing; apply moves a legacy key and a connector row; a second run finds them unchanged', async () => {
    const keyId = await legacy('PERPLEXITY_API_KEY', 'pplx-selfhost');
    const [connectorRow] = await db.insert(projectSecrets).values({
      projectId, identifier: 'SELFHOST_BOT_TOKEN', name: 'SELFHOST_BOT_TOKEN', valueEnc: encryptProjectSecret(projectId, 'selfhost-bot'),
      scope: 'connector', strategy: 'runtime', consumer: 'connector', createdBy: OWNER,
    }).returning({ secretId: projectSecrets.secretId });

    expect(await runLegacyCredentialBackfills('off')).toEqual({ mode: 'off', llm: null, connector: null });
    const ledgerOf = async (id: string) => (await db.select().from(llmCredentialBackfill).where(eq(llmCredentialBackfill.legacySecretId, id)))[0];
    expect(await ledgerOf(keyId)).toBeUndefined();

    const first = await runLegacyCredentialBackfills('apply');
    expect(first.llm?.copied).toBeGreaterThanOrEqual(1);
    expect((await ledgerOf(keyId))?.outcome).toBe('copied');
    const [moved] = await db.select().from(projectSecrets).where(eq(projectSecrets.secretId, connectorRow!.secretId));
    expect(moved!.strategy).toBe('broker');
    const keys = await resolveGatewayKeyValues({ ...scope(), providerId: 'perplexity', name: 'PERPLEXITY_API_KEY', probe: true });
    expect(keys).toMatchObject({ store: 'named', keys: [{ value: 'pplx-selfhost' }] });

    const second = await runLegacyCredentialBackfills('apply');
    expect(second.llm?.copied ?? 0).toBe(0);
    expect(second.connector).toEqual({ connector_secret_strategy: {}, connector_secret_consumer: {}, external_connection: {} });
  });
});
