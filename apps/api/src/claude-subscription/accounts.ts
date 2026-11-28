/**
 * Claude accounts: a member's Claude Pro or Max login (the token `claude
 * setup-token` printed), stored as a named provider account exactly like a
 * ChatGPT account (`secrets/provider-accounts.ts`): private to its creator
 * until shared, chosen per request by the LLM gateway, never sent to a sandbox.
 *
 * Which account a request uses, in the ChatGPT order:
 *   1. the session's selected accounts (`session_provider_secret_pools`);
 *   2. the personal-key owner's own newest account (not for a gateway API key);
 *   3. the accounts shared with the project that the principal may use.
 * Skipped: a resting account (after a rate or usage limit), one whose token
 * Anthropic refused (401: needs reconnection), and one Anthropic forbade (403,
 * for example when its organization turned Claude Code off) within the last
 * `CLAUDE_FORBIDDEN_HOLD_SECONDS`. After that hold the forbidden account is
 * tried once more; the first answer it gets clears the 403 reason
 * (`recordSubscriptionUsage` with `served`), a new 403 restarts the hold.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accountSecretResources, claudeSubscriptionLogins, sessionProviderSecretPools } from '@kortix/db';
import { GatewayResolutionError, type ClaudeCodeCredentials } from '@kortix/llm-gateway';
import { CLAUDE_AGENT_PROVIDER_ID } from '@kortix/api-contract/claude-agent';
import { getProjectGatewayResolution } from '../repositories/project-model-access';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import {
  listUsableGatewaySecrets,
  readAccountSecret,
  resolveDefaultProviderAccountSecret,
  resolveProjectSharedProviderSecrets,
  resolveSessionProviderSecrets,
  type ResolvedAccountSecret,
} from '../secrets/account-resource';
import type { ProviderAccountKind } from '../secrets/provider-accounts';

export const CLAUDE_ACCOUNT: ProviderAccountKind = { providerId: 'claude-agent', name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude' };

/** Who asks for a Claude account: the gateway principal's fields. */
interface ClaudeAccountPrincipal {
  accountId: string;
  projectId: string;
  userId: string;
  sessionId?: string | null;
  /** A gateway API key: no member, so only accounts shared with the whole project. */
  keyId?: string;
  /** Whose personal accounts count; null = none (a shared or unattended session). */
  personalUserId: string | null;
}

interface ClaudeCredential {
  secretId: string;
  label: string;
  token: string;
}

function accountsResting(subject: string, retryAfterSeconds: number | undefined): GatewayResolutionError {
  const suggestion = 'Retry after the cooldown, or connect another Claude account.';
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 60) {
    return new GatewayResolutionError('provider_pool_rate_limited', `${subject} are cooling down.`, suggestion,
      retryAfterSeconds, retryAfterSeconds);
  }
  const hours = retryAfterSeconds / 3600;
  const wait = hours >= 48 ? `${Math.round(hours / 24)} days`
    : hours >= 2 ? `${Math.round(hours)} hours`
    : `${Math.ceil(retryAfterSeconds / 60)} minutes`;
  return new GatewayResolutionError('provider_pool_rate_limited',
    `${subject} reached their usage limit. The first resets in ${wait}.`,
    'Choose another model, or connect another Claude account.', undefined, retryAfterSeconds);
}

/** How long a Claude account Anthropic forbade (403) is skipped before one more try. */
export const CLAUDE_FORBIDDEN_HOLD_SECONDS = 15 * 60;

/** Anthropic's 403 when the account's Claude organization turned Claude Code off. */
const ORGANIZATION_TURNED_OFF = /organization has disabled/i;

interface ForbiddenAccount {
  label: string;
  /** Anthropic's words in its 403 (`verify_message`). */
  message: string;
}

/** Every usable account Anthropic forbids: name them, Anthropic's reason, and the fix. */
function forbiddenAccounts(forbidden: ForbiddenAccount[], scope: 'selected' | 'shared' | 'own'): GatewayResolutionError {
  const named = forbidden.slice(0, 3).map((account) => `"${account.label}"`);
  const more = forbidden.length > 3 ? ` and ${forbidden.length - 3} more` : '';
  const first = forbidden[0]!;
  const sameReason = forbidden.every((account) => account.message === first.message);
  const message = forbidden.length === 1
    ? `Anthropic refuses the Claude account ${named[0]}: ${first.message}`
    : sameReason
      ? `Anthropic refuses ${forbidden.length} Claude accounts (${named.join(', ')}${more}): ${first.message}`
      : `Anthropic refuses ${forbidden.length} Claude accounts (${named.join(', ')}${more}). For ${named[0]} it says: ${first.message}`;
  const other = scope === 'selected' ? 'select another Claude account for this session'
    : scope === 'own' ? 'connect another Claude account'
    : 'share another Claude account with everyone in this workspace';
  const suggestion = forbidden.every((account) => ORGANIZATION_TURNED_OFF.test(account.message))
    ? `An admin of ${forbidden.length === 1 ? 'its' : 'their'} Claude organization must turn Claude Code back on, or ${other}.`
    : `${other[0]!.toUpperCase()}${other.slice(1)}.`;
  return new GatewayResolutionError('provider_reauth_required', message, suggestion);
}

const notConnected = () => new GatewayResolutionError('provider_not_connected',
  'Connect Claude to use this model.', 'Sign in with Claude under Models → Providers → Anthropic, then retry.');

function needsReconnection(labels: string[], scope: 'selected' | 'shared' | 'own'): GatewayResolutionError {
  const named = labels.slice(0, 3).map((label) => `"${label}"`).join(', ');
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
  const message = scope === 'own'
    ? `Your Claude account ${named} needs reconnection.`
    : labels.length === 1
      ? `The ${scope === 'shared' ? 'Claude account shared with this project' : 'selected Claude account'} ${named} needs reconnection.`
      : `${labels.length} ${scope === 'shared' ? 'Claude accounts shared with this project' : 'selected Claude accounts'} need reconnection: ${named}${more}.`;
  const suggestion = scope === 'own'
    ? 'Reconnect it under Models → Providers → Anthropic, then retry.'
    : 'The member who connected it must reconnect it, or select another Claude account.';
  return new GatewayResolutionError('provider_reauth_required', message, suggestion);
}

interface UsableAccounts {
  credentials: ClaudeCredential[];
  /** Labels of the accounts whose token Anthropic refused (401) or Kortix cannot read. */
  refused: string[];
  /** The accounts Anthropic forbade (403) within the hold. */
  forbidden: ForbiddenAccount[];
}

/** The accounts among `secrets` that Anthropic neither refused nor forbade, with their tokens. */
async function usable(accountId: string, secrets: ResolvedAccountSecret[]): Promise<UsableAccounts> {
  if (!secrets.length) return { credentials: [], refused: [], forbidden: [] };
  const flagged = new Map((await db.select({
    secretId: accountSecretResources.secretId,
    needsReauth: sql<boolean>`${accountSecretResources.needsReauthAt} is not null`,
    verifyMessage: accountSecretResources.verifyMessage,
  })
    .from(accountSecretResources)
    .where(and(
      eq(accountSecretResources.accountId, accountId),
      inArray(accountSecretResources.secretId, secrets.map((secret) => secret.secretId)),
      sql`(${accountSecretResources.needsReauthAt} is not null or (${accountSecretResources.verifyStatus} = 'invalid'
        and ${accountSecretResources.verifiedAt} > now() - make_interval(secs => ${CLAUDE_FORBIDDEN_HOLD_SECONDS})))`,
    ))).map((row) => [row.secretId, row]));
  const credentials: ClaudeCredential[] = [];
  const refused: string[] = [];
  const forbidden: ForbiddenAccount[] = [];
  for (const secret of secrets) {
    const flag = flagged.get(secret.secretId);
    if (flag?.needsReauth || !secret.value) refused.push(secret.label);
    else if (flag) forbidden.push({ label: secret.label, message: flag.verifyMessage || 'Anthropic answered 403 Forbidden.' });
    else credentials.push({ secretId: secret.secretId, label: secret.label, token: secret.value });
  }
  return { credentials, refused, forbidden };
}

/** The usable accounts, or why none is: a refused token first (a reconnect fixes it), then a 403. */
function usableOrWhy(accounts: UsableAccounts, scope: 'selected' | 'shared' | 'own'): ClaudeCredential[] | GatewayResolutionError {
  if (accounts.credentials.length) return accounts.credentials;
  if (accounts.refused.length) return needsReconnection(accounts.refused, scope);
  return forbiddenAccounts(accounts.forbidden, scope);
}

async function sharedCredentials(principal: ClaudeAccountPrincipal, probe?: boolean): Promise<ClaudeCredential[] | GatewayResolutionError | null> {
  const shared = await resolveProjectSharedProviderSecrets({
    accountId: principal.accountId, projectId: principal.projectId, userId: principal.userId,
    grantUserId: principal.keyId ? null : principal.personalUserId,
    providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
    sessionId: principal.sessionId, probe,
  });
  if (shared.secrets.length) return usableOrWhy(await usable(principal.accountId, shared.secrets), 'shared');
  if (shared.coolingDown) return accountsResting('All Claude accounts shared with this project', shared.retryAfterSeconds);
  return null;
}

/**
 * The Claude accounts a request may use, best first. Throws a
 * GatewayResolutionError that names why none is usable.
 */
export async function resolveClaudeCredentials(principal: ClaudeAccountPrincipal, options: { probe?: boolean } = {}): Promise<ClaudeCredential[]> {
  if (principal.sessionId) {
    const pool = await resolveSessionProviderSecrets({
      accountId: principal.accountId, projectId: principal.projectId, sessionId: principal.sessionId,
      // A probe (a turn gate, the picker) reads the pool without rotating it.
      ...(options.probe ? { advanceIndex: false } : {}),
      userId: principal.userId, grantUserId: principal.personalUserId,
      providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
    });
    if (pool.configured) {
      if (!pool.secrets.length) {
        throw pool.coolingDown
          ? accountsResting('All selected Claude accounts', pool.retryAfterSeconds)
          : new GatewayResolutionError('provider_not_connected', 'No usable Claude account is selected for this session.',
            'Select a Claude account you may use in session settings.');
      }
      const selected = usableOrWhy(await usable(principal.accountId, pool.secrets), 'selected');
      if (Array.isArray(selected)) return selected;
      throw selected;
    }
  }
  if (principal.personalUserId && !principal.keyId) {
    const own = await resolveDefaultProviderAccountSecret(principal.accountId, principal.projectId, principal.personalUserId, CLAUDE_ACCOUNT);
    const ready = own && !own.restingSeconds && !own.needsReauth && own.value ? usableOrWhy(await usable(principal.accountId, [own]), 'own') : null;
    if (Array.isArray(ready)) return ready;
    if (own) {
      // Resting, refused or forbidden: an account shared with the project may serve instead.
      const shared = await sharedCredentials(principal, options.probe);
      if (Array.isArray(shared)) return shared;
      if (own.restingSeconds) throw accountsResting('Your Claude accounts', own.restingSeconds);
      throw ready ?? needsReconnection([own.label], 'own');
    }
  }
  const shared = await sharedCredentials(principal, options.probe);
  if (Array.isArray(shared)) return shared;
  throw shared ?? notConnected();
}

/** Why a request with this principal has no Claude account to use now, or null when it has one. */
export async function claudeCredentialProblem(principal: ClaudeAccountPrincipal): Promise<GatewayResolutionError | null> {
  try {
    return (await resolveClaudeCredentials(principal, { probe: true })).length > 0 ? null : notConnected();
  } catch (err) {
    if (err instanceof GatewayResolutionError) return err;
    throw err;
  }
}

/** Whether a request with this principal has a Claude account to use now. */
export async function hasClaudeCredential(principal: ClaudeAccountPrincipal): Promise<boolean> {
  return (await claudeCredentialProblem(principal)) === null;
}

/** The Claude accounts `userId` may use in the project (their own and shared ones), without values. */
export async function countUsableClaudeAccounts(accountId: string, projectId: string, userId: string): Promise<number> {
  const rows = await listUsableGatewaySecrets({
    accountId, projectId, userId, providerId: CLAUDE_ACCOUNT.providerId, name: CLAUDE_ACCOUNT.name,
  });
  if (!rows.length) return 0;
  const refused = await db.select({ secretId: accountSecretResources.secretId }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, accountId),
    inArray(accountSecretResources.secretId, rows.map((row) => row.secretId)),
    sql`${accountSecretResources.needsReauthAt} is not null`,
  ));
  return rows.length - refused.length;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Anthropic refused this account's token (401): mark it for reconnection, so
 * the next request skips it and its owner sees "Needs reconnection". Only when
 * the stored token is still the refused one: a reconnect since then wins.
 */
export async function markClaudeAccountRefused(accountId: string, secretId: string, failedKeySha256: string): Promise<boolean> {
  const [row] = await db.select({ valueEnc: accountSecretResources.valueEnc }).from(accountSecretResources).where(and(
    eq(accountSecretResources.accountId, accountId),
    eq(accountSecretResources.secretId, secretId),
    eq(accountSecretResources.providerId, CLAUDE_ACCOUNT.providerId),
    isNull(accountSecretResources.needsReauthAt),
  )).limit(1);
  if (!row) return false;
  const current = readAccountSecret(accountId, secretId, row.valueEnc);
  if (!current || sha256(current) !== failedKeySha256) return false;
  await db.update(accountSecretResources)
    .set({ needsReauthAt: sql`coalesce(${accountSecretResources.needsReauthAt}, now())` })
    .where(and(eq(accountSecretResources.accountId, accountId), eq(accountSecretResources.secretId, secretId)));
  logger.warn('[claude-accounts] Anthropic refused a Claude account; it needs reconnection', { secretId });
  return true;
}

/**
 * Anthropic forbade this account (403): store its words as the account's
 * verification (`invalid`), which the account list shows and which skips the
 * account for `CLAUDE_FORBIDDEN_HOLD_SECONDS`. Each new 403 restarts the hold.
 * Only when the stored token is still the forbidden one: a reconnect since
 * then wins.
 */
export async function markClaudeAccountForbidden(accountId: string, secretId: string, failedKeySha256: string, message: string): Promise<boolean> {
  // `updated_at` as text: a JS Date drops the microseconds, so it would never compare equal.
  const [row] = await db.select({ valueEnc: accountSecretResources.valueEnc, updatedAt: sql<string>`${accountSecretResources.updatedAt}::text` })
    .from(accountSecretResources).where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.secretId, secretId),
      eq(accountSecretResources.providerId, CLAUDE_ACCOUNT.providerId),
    )).limit(1);
  if (!row) return false;
  const current = readAccountSecret(accountId, secretId, row.valueEnc);
  if (!current || sha256(current) !== failedKeySha256) return false;
  const [marked] = await db.update(accountSecretResources)
    .set({ verifyStatus: 'invalid', verifyMessage: message.slice(0, 500), verifiedAt: sql`now()` })
    // A reconnect between the read and this write bumps `updated_at`: the new token stays unmarked.
    .where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.secretId, secretId),
      sql`${accountSecretResources.updatedAt} = ${row.updatedAt}::timestamptz`,
    ))
    .returning({ secretId: accountSecretResources.secretId });
  if (!marked) return false;
  logger.warn('[claude-accounts] Anthropic forbade a Claude account; it is skipped for a while', { secretId });
  return true;
}

/** Delete the caller's own Claude accounts in a project (`kortix providers rm claude`). Returns how many. */
export async function deleteOwnClaudeAccounts(accountId: string, projectId: string, userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const own = await tx.select({ secretId: accountSecretResources.secretId }).from(accountSecretResources).where(and(
      eq(accountSecretResources.accountId, accountId),
      eq(accountSecretResources.projectId, projectId),
      eq(accountSecretResources.providerId, CLAUDE_ACCOUNT.providerId),
      eq(accountSecretResources.createdBy, userId),
    ));
    for (const { secretId } of own) {
      await tx.update(sessionProviderSecretPools)
        .set({ secretIds: sql`${sessionProviderSecretPools.secretIds} - ${secretId}`, updatedAt: new Date() })
        .where(sql`${sessionProviderSecretPools.secretIds} @> jsonb_build_array(${secretId}::text)`);
      await tx.delete(accountSecretResources).where(eq(accountSecretResources.secretId, secretId));
    }
    // The pre-named-account login is private to this member across the account.
    // Disconnect must remove it too, or usage discovery resurrects the login.
    const legacy = await tx.delete(claudeSubscriptionLogins).where(and(
      eq(claudeSubscriptionLogins.accountId, accountId),
      eq(claudeSubscriptionLogins.userId, userId),
    )).returning({ userId: claudeSubscriptionLogins.userId });
    return own.length + legacy.length;
  });
}

/** The answer the gateway's Claude Code passthrough needs: the accounts to try, or why none. */
export async function claudeCredentialsForGateway(principal: {
  accountId: string;
  projectId?: string;
  userId: string;
  sessionId?: string | null;
  keyId?: string;
  personalUserId?: string | null;
}, _model: string | null): Promise<ClaudeCodeCredentials> {
  if (!principal.projectId) {
    return { error: { status: 400, code: 'provider_not_connected', message: 'Claude models run in a workspace session.', suggestion: 'Use a workspace session token.' } };
  }
  // The provider switch applies to every call. A single turned-off model is
  // enforced where a turn's model is chosen (picker, session model change):
  // Claude Code also calls a smaller model on its own for side steps, and a
  // turn on an allowed model must not fail on that.
  const resolution = await getProjectGatewayResolution(principal.projectId);
  if (resolution.access.disabledProviders.includes(CLAUDE_AGENT_PROVIDER_ID)) {
    return { error: {
      status: 403, code: 'provider_disabled',
      message: 'Claude subscription models are turned off in this workspace.',
      suggestion: 'Turn them on under Models, or choose another model.',
    } };
  }
  try {
    const credentials = await resolveClaudeCredentials({
      accountId: principal.accountId, projectId: principal.projectId, userId: principal.userId,
      sessionId: principal.sessionId ?? null, keyId: principal.keyId,
      personalUserId: principal.personalUserId === undefined ? principal.userId : principal.personalUserId,
    });
    return { credentials: credentials.map((credential) => ({ secretId: credential.secretId, apiKey: credential.token })) };
  } catch (err) {
    if (!(err instanceof GatewayResolutionError)) throw err;
    return { error: {
      status: err.code === 'provider_pool_rate_limited' ? 429 : 400,
      code: err.code, message: err.message, suggestion: err.suggestion, retryAfterSeconds: err.retryAfterSeconds,
      // The gateway answers a rest over a minute as a usage limit, which Claude Code shows as one.
      ...(err.restSeconds !== undefined ? { restSeconds: err.restSeconds } : {}),
    } };
  }
}
