/**
 * One store for LLM provider credentials: the move of every legacy
 * `project_secrets` row with consumer `llm_gateway` into
 * `account_secret_resources`, the named accounts the Models panel lists.
 *
 * Until 2026-10-31 the gateway read provider keys from `project_secrets`
 * (name-keyed per project, `owner_user_id` = a member's personal override).
 * Since then the Models panel writes named accounts. Two stores with two rule
 * sets caused the outage class PR #12483 fixed. This module is the bridge:
 *
 *   - `moveLegacyLlmCredential` copies one legacy row into the named store and
 *     records the outcome in `kortix.llm_credential_backfill`. Idempotent: a
 *     re-run of a moved row is `unchanged`, and a legacy write after the copy
 *     re-copies the value into the same named account.
 *   - `backfillLegacyLlmCredentials` runs it over every legacy row (the
 *     operator script `apps/api/scripts/llm-credential-backfill.ts`).
 *   - `legacySecretNotMoved` (`llm-credential-ledger.ts`) is the SQL gate every
 *     legacy reader applies: a moved row is never read again.
 *   - `writeWorkspaceProviderKey` / `deleteWorkspaceProviderKeys` are what the
 *     old `/secrets` write paths do now: they write only the named store.
 *
 * How a legacy row maps (the decisions are in the PR body):
 *
 *   | legacy row                         | named account                                  |
 *   |------------------------------------|------------------------------------------------|
 *   | shared, no audience                | access `project`, label "Workspace key"        |
 *   | shared, audience of people only    | access `members`, a grant per person           |
 *   | shared, audience with a group/agent| skipped_audience: stays legacy, still read     |
 *   | personal override (owner set)      | access `members`, created by and granted to    |
 *   |                                    | the owner (the owner's own default)            |
 *   | AWS_REGION (Bedrock's region)      | provider `amazon-bedrock`, name `AWS_REGION`   |
 *   | CUSTOM_<ID>_API_KEY                | provider `<id>` (the project's custom provider)|
 *   | CODEX_AUTH_JSON (ChatGPT login)    | provider `codex`                               |
 *   | a name no reader reads             | skipped_unread                                 |
 *
 * The value is decrypted with the project-secret envelope and sealed again
 * with `encryptAccountSecret` for the project's account. No value is logged.
 */
import { accountMembers, accountSecretGrants, accountSecretResources, llmCredentialBackfill, projectSecrets, roleAssignments } from '@kortix/db';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { decryptProjectSecret } from '../projects/surface';
import { projectsView } from '../workspaces/rows';
import { readCustomProviders, customProviderSecretName } from '../llm-gateway/custom-providers';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { runtimeModelCatalog } from '../llm-gateway/models/runtime-catalog';
import { decryptAccountSecret, encryptAccountSecret } from './account-resource';

export { LLM_CREDENTIAL_MOVED_OUTCOMES } from './llm-credential-ledger';
import { LLM_CREDENTIAL_MOVED_OUTCOMES } from './llm-credential-ledger';

export type LlmCredentialMoveOutcome =
  | (typeof LLM_CREDENTIAL_MOVED_OUTCOMES)[number]
  /** Already moved, and the legacy row did not change since. */
  | 'unchanged'
  /** Already moved; the legacy row changed since, so its value went to the named account again. */
  | 'recopied'
  /** Inactive personal override: no reader uses it. */
  | 'skipped_inactive'
  /** No reader reads this name (Azure's resource name, a deleted custom provider, …). */
  | 'skipped_unread'
  /** Narrowed to a group or an agent, which a named account cannot express. Stays legacy. */
  | 'skipped_audience'
  /** A personal override whose owner left the account, or a row with no creator. */
  | 'skipped_no_owner'
  /** The project has no account: no reader can reach the row. */
  | 'skipped_no_account'
  | 'failed_undecryptable';

import { BEDROCK_PROVIDER_ID, BEDROCK_REGION_NAME, WORKSPACE_KEY_LABEL } from './llm-credential-names';

const CODEX_NAME = 'CODEX_AUTH_JSON';

export interface LlmCredentialTarget {
  providerId: string;
  /** `setting`: a value next to a provider's key (Bedrock's region), not a key. */
  kind: 'key' | 'login' | 'setting';
}

let catalogKeyNames: { at: number; map: Map<string, string> } | null = null;

/** Catalog provider id per key name, as the gateway reads it (`resolveCatalogUpstream(...).envVar`). */
function catalogProviderForName(name: string): string | null {
  const snapshot = runtimeModelCatalog.snapshot();
  if (!catalogKeyNames || catalogKeyNames.at !== snapshot.providers.length) {
    const map = new Map<string, string>();
    for (const provider of snapshot.providers) {
      const upstream = resolveCatalogUpstream(provider.id, undefined, snapshot);
      if (upstream && !map.has(upstream.envVar)) map.set(upstream.envVar, provider.id);
    }
    catalogKeyNames = { at: snapshot.providers.length, map };
  }
  return catalogKeyNames.map.get(name) ?? null;
}

/**
 * Where a legacy `llm_gateway` name lives in the named store, or null when no
 * reader reads it. `customProviderIds`: the project's custom providers.
 */
export function llmCredentialTargetOf(name: string, customProviderIds: readonly string[]): LlmCredentialTarget | null {
  const upper = name.trim().toUpperCase();
  if (upper === CODEX_NAME) return { providerId: 'codex', kind: 'login' };
  if (upper === BEDROCK_REGION_NAME) return { providerId: BEDROCK_PROVIDER_ID, kind: 'setting' };
  const custom = customProviderIds.find((id) => customProviderSecretName(id) === upper);
  if (custom) return { providerId: custom, kind: 'key' };
  const catalog = catalogProviderForName(upper);
  return catalog ? { providerId: catalog, kind: 'key' } : null;
}

/** The label a moved row gets in the Models panel. */
function labelFor(target: LlmCredentialTarget, personal: boolean): string {
  if (target.kind === 'setting') return 'Bedrock region';
  if (target.kind === 'login') return personal ? 'ChatGPT' : 'Workspace ChatGPT';
  return personal ? 'Personal key' : WORKSPACE_KEY_LABEL;
}

type LegacyRow = typeof projectSecrets.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface ProjectFacts { accountId: string; customProviderIds: string[] }

async function projectFacts(tx: Tx | typeof db, projectId: string): Promise<ProjectFacts | null> {
  const [row] = await tx.select({ accountId: projectsView.accountId, metadata: projectsView.metadata })
    .from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  return row?.accountId ? { accountId: row.accountId, customProviderIds: readCustomProviders(row.metadata).map((p) => p.id) } : null;
}

async function isMember(tx: Tx | typeof db, accountId: string, userId: string): Promise<boolean> {
  const rows = await tx.select({ userId: accountMembers.userId }).from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId))).limit(1);
  return rows.length > 0;
}

/** Who may use a shared legacy value: everyone, some people, or a group/agent audience. */
async function audienceOf(tx: Tx | typeof db, projectId: string, secretId: string): Promise<'open' | { users: string[] } | 'unmappable'> {
  const grants = await tx.select({ principalType: roleAssignments.principalType, principalId: roleAssignments.principalId })
    .from(roleAssignments).where(and(
      eq(roleAssignments.scopeType, 'project'), eq(roleAssignments.scopeId, projectId),
      eq(roleAssignments.objectType, 'secret'), eq(roleAssignments.objectId, secretId),
      or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
    ));
  if (!grants.length || grants.some((g) => g.principalType === 'project')) return 'open';
  // A person's grant is stored as `user` (and `member` on older rows).
  if (grants.every((g) => g.principalType === 'user' || g.principalType === 'member')) return { users: [...new Set(grants.map((g) => g.principalId))] };
  return 'unmappable';
}

export interface LlmCredentialMoveResult {
  legacySecretId: string;
  projectId: string;
  name: string;
  outcome: LlmCredentialMoveOutcome;
  accountSecretId?: string;
  detail?: string;
}

/** The named account of the same provider, name and value in the project, if one exists. */
async function sameValueAccount(tx: Tx, accountId: string, projectId: string, target: LlmCredentialTarget, name: string, value: string): Promise<string | null> {
  const rows = await tx.select({ secretId: accountSecretResources.secretId, valueEnc: accountSecretResources.valueEnc })
    .from(accountSecretResources).where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.consumer, 'llm_gateway'),
      eq(accountSecretResources.providerId, target.providerId),
      eq(accountSecretResources.name, name),
      or(eq(accountSecretResources.projectId, projectId), isNull(accountSecretResources.projectId)),
    ));
  for (const row of rows) {
    try {
      if (decryptAccountSecret(accountId, row.valueEnc) === value) return row.secretId;
    } catch { /* an unreadable row is not a match */ }
  }
  return null;
}

async function record(tx: Tx, row: LegacyRow, accountId: string | null, outcome: LlmCredentialMoveOutcome, accountSecretId: string | null, detail?: string) {
  // `unchanged` and `recopied` keep the row's moved outcome.
  const stored = outcome === 'recopied' ? 'copied' : outcome;
  const values = {
    legacySecretId: row.secretId, projectId: row.projectId, accountId, name: row.name,
    outcome: stored, accountSecretId, legacyUpdatedAt: row.updatedAt, detail: detail ?? null, updatedAt: new Date(),
  };
  await tx.insert(llmCredentialBackfill).values(values).onConflictDoUpdate({ target: llmCredentialBackfill.legacySecretId, set: values });
}

/**
 * Decide and (with `apply`) perform the move of one legacy row, in one
 * transaction that holds the legacy row's lock, so a concurrent legacy write
 * waits and is then seen by the next run as a change to re-copy.
 */
export async function moveLegacyLlmCredential(legacySecretId: string, options: { apply: boolean }): Promise<LlmCredentialMoveResult | null> {
  // A dry run writes nothing (every write below is behind `apply`) and takes no lock.
  return db.transaction(async (tx) => {
    const query = tx.select().from(projectSecrets)
      .where(and(eq(projectSecrets.secretId, legacySecretId), eq(projectSecrets.consumer, 'llm_gateway')));
    const [row] = await (options.apply ? query.for('update') : query).limit(1);
    return row ? planAndApply(tx, row, options.apply) : null;
  });
}

async function planAndApply(tx: Tx, row: LegacyRow, apply: boolean): Promise<LlmCredentialMoveResult> {
  const base = { legacySecretId: row.secretId, projectId: row.projectId, name: row.name };
  const done = (outcome: LlmCredentialMoveOutcome, accountSecretId?: string, detail?: string): LlmCredentialMoveResult =>
    ({ ...base, outcome, ...(accountSecretId ? { accountSecretId } : {}), ...(detail ? { detail } : {}) });
  const facts = await projectFacts(tx, row.projectId);
  if (!facts) {
    // Recorded, so the purge's "every row has a ledger row" gate holds.
    if (apply) await record(tx, row, null, 'skipped_no_account', null, 'project has no account');
    return done('skipped_no_account', undefined, 'project has no account');
  }
  const { accountId } = facts;

  const [ledger] = await tx.select().from(llmCredentialBackfill).where(eq(llmCredentialBackfill.legacySecretId, row.secretId)).limit(1);
  const moved = ledger && (LLM_CREDENTIAL_MOVED_OUTCOMES as readonly string[]).includes(ledger.outcome);
  if (moved && ledger.legacyUpdatedAt.getTime() >= row.updatedAt.getTime()) return done('unchanged', ledger.accountSecretId ?? undefined);

  const target = llmCredentialTargetOf(row.name, facts.customProviderIds);
  if (!target) {
    if (apply) await record(tx, row, accountId, 'skipped_unread', null);
    return done('skipped_unread');
  }
  if (!row.active) {
    if (apply) await record(tx, row, accountId, 'skipped_inactive', null);
    return done('skipped_inactive');
  }
  let value: string;
  try {
    value = decryptProjectSecret(row.projectId, row.valueEnc);
  } catch {
    if (apply) await record(tx, row, accountId, 'failed_undecryptable', null);
    return done('failed_undecryptable');
  }

  // A legacy write after the copy: the same named account takes the new value.
  if (moved && ledger.accountSecretId) {
    if (apply) {
      const updated = await tx.update(accountSecretResources)
        .set({ valueEnc: encryptAccountSecret(accountId, value), needsReauthAt: null, updatedAt: new Date() })
        .where(and(eq(accountSecretResources.secretId, ledger.accountSecretId), eq(accountSecretResources.accountId, accountId)))
        .returning({ secretId: accountSecretResources.secretId });
      // The named account was deleted in the Models panel: it stays deleted.
      await record(tx, row, accountId, updated.length ? 'recopied' : ledger.outcome as LlmCredentialMoveOutcome, ledger.accountSecretId,
        updated.length ? undefined : 'named account deleted; the legacy value stays unread');
      return done(updated.length ? 'recopied' : 'unchanged', ledger.accountSecretId);
    }
    return done('recopied', ledger.accountSecretId);
  }

  const personal = row.ownerUserId !== null;
  let accessMode: 'project' | 'members' = 'project';
  let grantees: string[] = [];
  if (personal) {
    if (!(await isMember(tx, accountId, row.ownerUserId!))) {
      if (apply) await record(tx, row, accountId, 'skipped_no_owner', null, 'owner is not an account member');
      return done('skipped_no_owner', undefined, 'owner is not an account member');
    }
    accessMode = 'members';
    grantees = [row.ownerUserId!];
  } else {
    const audience = await audienceOf(tx, row.projectId, row.secretId);
    if (audience === 'unmappable') {
      if (apply) await record(tx, row, accountId, 'skipped_audience', null, 'shared with a group or an agent');
      return done('skipped_audience', undefined, 'shared with a group or an agent');
    }
    if (audience !== 'open') {
      accessMode = 'members';
      for (const userId of audience.users) if (await isMember(tx, accountId, userId)) grantees.push(userId);
    }
  }
  const createdBy = row.ownerUserId ?? row.createdBy;
  if (!createdBy) {
    if (apply) await record(tx, row, accountId, 'skipped_no_owner', null, 'no creator recorded');
    return done('skipped_no_owner', undefined, 'no creator recorded');
  }

  const existing = await sameValueAccount(tx, accountId, row.projectId, target, row.name, value);
  if (existing) {
    if (apply) await record(tx, row, accountId, 'already_present', existing);
    return done('already_present', existing);
  }
  if (!apply) return done('copied');

  const [created] = await tx.insert(accountSecretResources).values({
    accountId, projectId: row.projectId, accessMode, label: labelFor(target, personal),
    providerId: target.providerId, name: row.name, valueEnc: encryptAccountSecret(accountId, value),
    consumer: 'llm_gateway', strategy: 'broker', createdBy,
  }).returning({ secretId: accountSecretResources.secretId });
  // The creator holds a grant, as the create route gives one, when still a member.
  if (await isMember(tx, accountId, createdBy)) grantees = [...new Set([createdBy, ...grantees])];
  if (grantees.length) {
    await tx.insert(accountSecretGrants).values(grantees.map((userId) => ({ accountId, secretId: created!.secretId, userId, grantedBy: createdBy })))
      .onConflictDoNothing();
  }
  await record(tx, row, accountId, 'copied', created!.secretId);
  return done('copied', created!.secretId);
}

export interface LlmCredentialBackfillSummary {
  scanned: number;
  outcomes: Record<string, number>;
  results: LlmCredentialMoveResult[];
}

/**
 * Move every legacy `llm_gateway` row (or one project's), oldest first, in
 * pages of `pageSize`. Each row is its own transaction: a failure stops only
 * that row. A dry run (`apply: false`) writes nothing and reports the plan.
 */
export async function backfillLegacyLlmCredentials(options: {
  apply: boolean;
  projectId?: string;
  pageSize?: number;
  onResult?: (result: LlmCredentialMoveResult) => void;
}): Promise<LlmCredentialBackfillSummary> {
  const pageSize = options.pageSize ?? 200;
  const summary: LlmCredentialBackfillSummary = { scanned: 0, outcomes: {}, results: [] };
  let after: string | null = null;
  for (;;) {
    const page: Array<{ secretId: string }> = await db.select({ secretId: projectSecrets.secretId }).from(projectSecrets)
      .where(and(
        eq(projectSecrets.consumer, 'llm_gateway'),
        ...(options.projectId ? [eq(projectSecrets.projectId, options.projectId)] : []),
        ...(after ? [gt(projectSecrets.secretId, after)] : []),
      ))
      .orderBy(asc(projectSecrets.secretId)).limit(pageSize);
    if (!page.length) break;
    for (const { secretId } of page) {
      let result: LlmCredentialMoveResult | null;
      try {
        result = await moveLegacyLlmCredential(secretId, { apply: options.apply });
      } catch (err) {
        result = { legacySecretId: secretId, projectId: '', name: '', outcome: 'failed_undecryptable',
          detail: `error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
      }
      if (!result) continue;
      summary.scanned += 1;
      summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
      summary.results.push(result);
      options.onResult?.(result);
    }
    after = page[page.length - 1]!.secretId;
  }
  return summary;
}

/**
 * The old `/secrets` write for a provider key: the value goes to the
 * project's "Workspace key" named account for that provider (created when
 * missing), never to `project_secrets`. A shared legacy row of the same name
 * is marked `superseded`, so readers stop using it. Null when no reader reads
 * the name: the caller keeps its old behavior for it.
 */
export async function writeWorkspaceProviderKey(input: {
  accountId: string;
  projectId: string;
  userId: string;
  name: string;
  value: string;
}): Promise<{ secretId: string; providerId: string; created: boolean } | null> {
  const name = input.name.trim().toUpperCase();
  const facts = await projectFacts(db, input.projectId);
  if (!facts || facts.accountId !== input.accountId) return null;
  const target = llmCredentialTargetOf(name, facts.customProviderIds);
  if (!target || target.kind === 'login') return null;
  const label = labelFor(target, false);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ secretId: accountSecretResources.secretId }).from(accountSecretResources).where(and(
      eq(accountSecretResources.accountId, input.accountId), eq(accountSecretResources.projectId, input.projectId),
      eq(accountSecretResources.consumer, 'llm_gateway'), eq(accountSecretResources.providerId, target.providerId),
      eq(accountSecretResources.name, name), eq(accountSecretResources.accessMode, 'project'), eq(accountSecretResources.label, label),
    )).orderBy(asc(accountSecretResources.createdAt)).limit(1).for('update');
    let secretId: string;
    if (existing) {
      await tx.update(accountSecretResources).set({
        valueEnc: encryptAccountSecret(input.accountId, input.value), active: true,
        cooldownUntil: null, cooldownProbeAt: null, needsReauthAt: null,
        // A new value: the last check was of the old one.
        verifyStatus: null, verifiedAt: null, verifyMessage: null, updatedAt: new Date(),
      }).where(eq(accountSecretResources.secretId, existing.secretId));
      secretId = existing.secretId;
    } else {
      const [created] = await tx.insert(accountSecretResources).values({
        accountId: input.accountId, projectId: input.projectId, accessMode: 'project', label,
        providerId: target.providerId, name, valueEnc: encryptAccountSecret(input.accountId, input.value),
        consumer: 'llm_gateway', strategy: 'broker', createdBy: input.userId,
      }).returning({ secretId: accountSecretResources.secretId });
      secretId = created!.secretId;
      if (await isMember(tx, input.accountId, input.userId)) {
        await tx.insert(accountSecretGrants).values({ accountId: input.accountId, secretId, userId: input.userId, grantedBy: input.userId }).onConflictDoNothing();
      }
    }
    // The shared legacy value of this name is replaced: readers stop using it.
    const legacy = await tx.select().from(projectSecrets).where(and(
      eq(projectSecrets.projectId, input.projectId), eq(projectSecrets.name, name),
      eq(projectSecrets.consumer, 'llm_gateway'), isNull(projectSecrets.ownerUserId),
    ));
    for (const row of legacy) await record(tx, row, input.accountId, 'superseded', secretId, 'replaced by a write to the named store');
    return { secretId, providerId: target.providerId, created: !existing };
  });
}

/**
 * The old `/secrets` delete for a provider key: removes the project's
 * "Workspace key" named accounts of that name (the ones a legacy write or the
 * backfill made). Keys people added in the Models panel under their own label
 * stay. Returns how many were removed.
 */
export async function deleteWorkspaceProviderKeys(input: { accountId: string; projectId: string; name: string }): Promise<number> {
  const name = input.name.trim().toUpperCase();
  const facts = await projectFacts(db, input.projectId);
  if (!facts || facts.accountId !== input.accountId) return 0;
  const target = llmCredentialTargetOf(name, facts.customProviderIds);
  if (!target || target.kind === 'login') return 0;
  const removed = await db.delete(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, input.accountId), eq(accountSecretResources.projectId, input.projectId),
    eq(accountSecretResources.consumer, 'llm_gateway'), eq(accountSecretResources.providerId, target.providerId),
    eq(accountSecretResources.name, name), eq(accountSecretResources.accessMode, 'project'),
    inArray(accountSecretResources.label, [labelFor(target, false)]),
  )).returning({ secretId: accountSecretResources.secretId });
  return removed.length;
}

/**
 * Move the shared legacy rows of one name in one project now (a custom
 * provider's key saved before the provider existed). Failures are logged by
 * outcome, never thrown: the legacy value stays readable.
 */
export async function moveLegacyProviderKeysNamed(projectId: string, name: string): Promise<LlmCredentialMoveResult[]> {
  const rows = await db.select({ secretId: projectSecrets.secretId }).from(projectSecrets).where(and(
    eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name.trim().toUpperCase()),
    eq(projectSecrets.consumer, 'llm_gateway'),
  ));
  const results: LlmCredentialMoveResult[] = [];
  for (const { secretId } of rows) {
    const result = await moveLegacyLlmCredential(secretId, { apply: true }).catch(() => null);
    if (result) results.push(result);
  }
  return results;
}


