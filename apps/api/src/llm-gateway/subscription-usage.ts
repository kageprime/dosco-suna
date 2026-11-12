/**
 * Plan usage of a subscription login (a ChatGPT or Claude account stored as an
 * account secret resource): how much of its 5-hour and weekly windows is used.
 *
 * Two writers keep `account_secret_resources.usage` current:
 *   1. the gateway, from the headers of every model response on that login
 *      (`/internal/gateway/pool-usage`, throttled per replica);
 *   2. `refreshSubscriptionUsage`, which asks the provider's usage API when
 *      someone opens the account list, at most once a minute per login. It
 *      costs no plan quota: ChatGPT `GET /backend-api/wham/usage`, Claude
 *      `GET /api/oauth/usage`.
 * A refresh the provider refuses keeps the last stored snapshot.
 */
import { accountSecretResources } from '@kortix/db';
import { byWindowLength, isBlockingWindow, resetIso, usageSnapshot, type SubscriptionUsage, type UsageWindowInput } from '@kortix/llm-gateway';
import { and, eq, sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { readAccountSecret } from '../secrets/account-resource';
import { CODEX_USER_AGENT, resolveCodexAccountCredential } from './credentials/codex';
import { parseCodexAuth } from './credentials/codex-core';
import { parseAntigravityAuth } from './credentials/antigravity';

export const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'claude-agent', 'antigravity']);

/** Every window a login reports fits: Claude names up to 7, ChatGPT 4 plus 2 per model limit (10 models). */
const MAX_WINDOWS = 24;


export const SubscriptionUsageSchema = z.object({
  windows: z.array(z.object({
    id: z.string().min(1).max(40),
    window_minutes: z.number().int().positive().nullable(),
    used_percent: z.number().min(0).max(100),
    resets_at: z.string().datetime().nullable(),
  })).max(MAX_WINDOWS),
  limited: z.boolean(),
  observed_at: z.string().datetime(),
  source: z.enum(['response', 'usage_endpoint']),
});

/** Who a login signs in as. Either field is null when the provider does not say. */
export const SubscriptionAccountSchema = z.object({
  email: z.string().nullable(),
  /** The provider's plan name, lower case: `plus`, `pro`, `team`, `max`, … */
  plan: z.string().nullable(),
});
export type SubscriptionAccount = z.infer<typeof SubscriptionAccountSchema>;

function jwtClaims(jwt: string): Record<string, any> | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** A ChatGPT login's email and plan, from the claims of its stored access token. No network. */
export function codexAccountFromLogin(value: string | null): SubscriptionAccount | null {
  const access = value ? parseCodexAuth(value)?.access : undefined;
  const claims = access ? jwtClaims(access) : null;
  if (!claims) return null;
  const email = text(claims['https://api.openai.com/profile']?.email) ?? text(claims.email);
  const plan = text(claims['https://api.openai.com/auth']?.chatgpt_plan_type)?.toLowerCase() ?? null;
  return email || plan ? { email, plan } : null;
}

/** Claude's `GET /api/oauth/profile` body: `account.email` and the plan of the organization. */
export function claudeAccountFromProfile(body: unknown): SubscriptionAccount | null {
  const account = (body as { account?: Record<string, unknown> } | null)?.account;
  if (!account || typeof account !== 'object') return null;
  const organization = (body as { organization?: Record<string, unknown> }).organization;
  const type = text(organization?.organization_type)?.toLowerCase().replace(/^claude_/, '') ?? null;
  const plan = type ?? (account.has_claude_max === true ? 'max' : account.has_claude_pro === true ? 'pro' : null);
  const email = text(account.email) ?? text(account.email_address);
  return email || plan ? { email, plan } : null;
}

/** A stored Claude identity: `{ email, plan, checked_at }`; the profile is asked again a day after a refusal. */
const StoredClaudeAccountSchema = SubscriptionAccountSchema.extend({ checked_at: z.string() });
const PROFILE_RETRY_MS = 24 * 60 * 60 * 1000;

/** A Google Antigravity login's email and plan from its stored credentials JSON. No network. */
export function antigravityAccountFromLogin(value: string | null): SubscriptionAccount | null {
  if (!value) return null;
  const auth = parseAntigravityAuth(value);
  if (!auth) return null;
  const email = text(auth.email);
  const plan = text(auth.plan) ?? 'pro';
  return email || plan ? { email, plan } : null;
}

/** Who the row's login signs in as: decoded for ChatGPT & Antigravity, stored for Claude. */
export function subscriptionAccount(row: Pick<UsageRow, 'accountId' | 'secretId' | 'providerId' | 'valueEnc' | 'providerAccount'>): SubscriptionAccount | null {
  if (row.providerId === 'codex') return codexAccountFromLogin(readAccountSecret(row.accountId, row.secretId, row.valueEnc));
  if (row.providerId === 'antigravity') return antigravityAccountFromLogin(readAccountSecret(row.accountId, row.secretId, row.valueEnc));
  if (row.providerId !== 'claude-agent') return null;
  const stored = StoredClaudeAccountSchema.safeParse(row.providerAccount);
  return stored.success && (stored.data.email || stored.data.plan) ? { email: stored.data.email, plan: stored.data.plan } : null;
}

/** The stored snapshot, or null when none was seen or it no longer parses. */
export function storedSubscriptionUsage(value: unknown): SubscriptionUsage | null {
  const parsed = SubscriptionUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `seven_day_opus` and `7d_opus` name one window: the endpoint and the headers spell it differently. */
function windowKey(id: string): string {
  return id.replace(/^seven_day_/, '7d_');
}

/**
 * The windows a model response's headers never carry (code review, extra
 * usage, a model's own limit) stay until their reset passes: a response
 * snapshot replaces the windows it names and keeps the rest. A usage-endpoint
 * read names every window, so it replaces the whole snapshot.
 */
export function mergeSubscriptionUsage(stored: SubscriptionUsage | null, next: SubscriptionUsage): SubscriptionUsage {
  if (next.source === 'usage_endpoint' || !stored) return next;
  const named = new Set(next.windows.map(window => windowKey(window.id)));
  const now = Date.parse(next.observed_at);
  const kept = stored.windows.filter(window => !named.has(windowKey(window.id))
    && (!window.resets_at || Date.parse(window.resets_at) > now));
  return kept.length ? { ...next, windows: [...next.windows, ...kept].slice(0, MAX_WINDOWS) } : next;
}

/**
 * Store a snapshot unless a newer one is already stored: two replicas may
 * report the same login out of order. A response snapshot keeps the stored
 * windows it does not name (`mergeSubscriptionUsage`).
 */
export async function recordSubscriptionUsage(secretId: string, accountId: string, usage: SubscriptionUsage): Promise<void> {
  const where = and(eq(accountSecretResources.secretId, secretId), eq(accountSecretResources.accountId, accountId));
  // Read, merge and write under the row lock: a concurrent write cannot land
  // between the read and the merge and be dropped.
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ usage: accountSecretResources.usage }).from(accountSecretResources).where(where).for('update');
    if (!row) return;
    const stored = storedSubscriptionUsage(row.usage);
    if (stored && Date.parse(stored.observed_at) > Date.parse(usage.observed_at)) return;
    await tx.update(accountSecretResources).set({ usage: mergeSubscriptionUsage(stored, usage) }).where(where);
  });
}

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

const REFRESH_EVERY_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 8_000;

type CodexRateLimit = Record<string, unknown> | null | undefined;

/** The `{primary,secondary}_window` pair of one ChatGPT rate limit, shortest first. */
function codexWindows(rateLimit: CodexRateLimit, now: number): UsageWindowInput[] {
  if (!rateLimit || typeof rateLimit !== 'object') return [];
  const windows: UsageWindowInput[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = rateLimit[`${slot}_window`] as Record<string, unknown> | null | undefined;
    if (!window || typeof window.used_percent !== 'number') continue;
    const seconds = typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : null;
    windows.push({
      fallback: slot,
      used_percent: window.used_percent,
      window_minutes: seconds ? Math.round(seconds / 60) : null,
      resets_at: resetIso(window.reset_at, now, window.reset_after_seconds),
    });
  }
  return windows.sort(byWindowLength);
}

/** `GPT-5.3 Codex Spark` → `gpt_5_3_codex_spark`: a window id fragment. */
function slug(value: unknown): string | null {
  const text = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : '';
  return text ? text.slice(0, 24) : null;
}

/** A secondary limit's windows under their own id prefix: `code_review_weekly`, `model_spark_five_hour`. */
function prefixed(prefix: string, rateLimit: CodexRateLimit, now: number): SubscriptionUsage['windows'] {
  const snapshot = usageSnapshot(codexWindows(rateLimit, now), { limited: false, now, source: 'usage_endpoint' });
  return (snapshot?.windows ?? []).map(window => ({ ...window, id: `${prefix}_${window.id}` }));
}

/** `limited` from the windows that stop model calls, or the provider's own word. */
function withLimit(usage: SubscriptionUsage | null, refused: boolean): SubscriptionUsage | null {
  if (!usage) return null;
  const limited = refused || usage.windows.some(window => isBlockingWindow(window.id) && window.used_percent >= 100);
  return { ...usage, limited, windows: usage.windows.slice(0, MAX_WINDOWS) };
}

/**
 * ChatGPT's `wham/usage` body: `rate_limit.{primary,secondary}_window`
 * (`used_percent` 0–100), the code-review allowance
 * `code_review_rate_limit`, and per-model limits in
 * `additional_rate_limits[].{limit_name,rate_limit}`.
 */
export function codexUsageFromBody(body: unknown, now = Date.now()): SubscriptionUsage | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const rateLimit = record.rate_limit as CodexRateLimit;
  const main = usageSnapshot(codexWindows(rateLimit, now), { limited: false, now, source: 'usage_endpoint' });
  const extra = [...prefixed('code_review', record.code_review_rate_limit as CodexRateLimit, now)];
  for (const limit of Array.isArray(record.additional_rate_limits) ? record.additional_rate_limits : []) {
    const name = slug((limit as Record<string, unknown> | null)?.limit_name ?? (limit as Record<string, unknown> | null)?.metered_feature);
    if (name) extra.push(...prefixed(`model_${name}`, (limit as Record<string, unknown>).rate_limit as CodexRateLimit, now));
  }
  const windows = [...(main?.windows ?? []), ...extra];
  if (!windows.length) return null;
  const refused = Boolean(rateLimit && typeof rateLimit === 'object' && (rateLimit.limit_reached === true || rateLimit.allowed === false));
  return withLimit({ windows, limited: false, observed_at: new Date(now).toISOString(), source: 'usage_endpoint' }, refused);
}

const CLAUDE_WINDOWS: Record<string, number | null> = { five_hour: 300, seven_day: 7 * 24 * 60, seven_day_opus: 7 * 24 * 60, seven_day_sonnet: 7 * 24 * 60, seven_day_fable: 7 * 24 * 60, seven_day_oauth_apps: 7 * 24 * 60 };

/**
 * Claude's `oauth/usage` body: `{ five_hour, seven_day, seven_day_opus, … }`
 * with `utilization` 0–100, and `extra_usage` (`is_enabled`, `utilization`)
 * when the plan pays for usage past its limits.
 */
export function claudeUsageFromBody(body: unknown, now = Date.now()): SubscriptionUsage | null {
  if (!body || typeof body !== 'object') return null;
  const windows: UsageWindowInput[] = [];
  for (const [name, minutes] of Object.entries(CLAUDE_WINDOWS)) {
    const window = (body as Record<string, { utilization?: unknown; resets_at?: unknown } | null>)[name];
    if (!window || typeof window.utilization !== 'number') continue;
    // A model-specific weekly window keeps its own id; only `seven_day` is `weekly`.
    windows.push({
      fallback: name === 'seven_day' ? 'weekly' : name,
      used_percent: window.utilization,
      window_minutes: name === 'seven_day' || name === 'five_hour' ? minutes : null,
      resets_at: resetIso(window.resets_at, now),
    });
  }
  const extra = (body as { extra_usage?: { is_enabled?: unknown; utilization?: unknown } | null }).extra_usage;
  if (extra?.is_enabled === true && typeof extra.utilization === 'number') {
    windows.push({ fallback: 'extra_usage', used_percent: extra.utilization, window_minutes: null, resets_at: null });
  }
  return withLimit(usageSnapshot(windows.sort(byWindowLength), { limited: false, now, source: 'usage_endpoint' }), false);
}

type UsageRow = Pick<typeof accountSecretResources.$inferSelect,
  'secretId' | 'accountId' | 'projectId' | 'providerId' | 'valueEnc' | 'createdBy' | 'updatedAt' | 'usage' | 'usageCheckedAt' | 'providerAccount'>;

async function fetchJson(fetchImpl: FetchImpl, url: string, headers: Record<string, string>): Promise<unknown | null> {
  const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!response.ok) {
    logger.warn('[subscription-usage] the provider refused a usage read', { url, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return response.json().catch(() => null);
}

async function providerUsage(row: UsageRow, fetchImpl: FetchImpl): Promise<SubscriptionUsage | null> {
  if (row.providerId === 'claude-agent') {
    const token = readAccountSecret(row.accountId, row.secretId, row.valueEnc);
    if (!token) return null;
    const headers = { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' };
    const [body] = await Promise.all([
      fetchJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', headers),
      refreshClaudeAccount(row, headers, fetchImpl),
    ]);
    return claudeUsageFromBody(body);
  }
  // Read-only: the stored access token as is. A usage read never refreshes a
  // login and never marks it for reconnection; model calls do both. An expired
  // token reads nothing, and the stored snapshot stays.
  const credential = await resolveCodexAccountCredential({
    projectId: row.projectId ?? '', accountId: row.accountId, sessionId: null, userId: row.createdBy,
    secretId: row.secretId, value: readAccountSecret(row.accountId, row.secretId, row.valueEnc), updatedAt: row.updatedAt,
    probe: true,
  }, fetchImpl);
  if (!credential) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${credential.access}`, 'user-agent': CODEX_USER_AGENT, accept: 'application/json' };
  if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId;
  return codexUsageFromBody(await fetchJson(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', headers));
}

/**
 * Ask Claude's profile API who the login is, once: again only a day after a
 * refusal (a `setup-token` login may lack the profile scope). Stores
 * `{ email, plan, checked_at }`; a reconnect clears it.
 */
async function refreshClaudeAccount(row: UsageRow, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<void> {
  const stored = StoredClaudeAccountSchema.safeParse(row.providerAccount);
  if (stored.success && (stored.data.email || Date.now() - Date.parse(stored.data.checked_at) < PROFILE_RETRY_MS)) return;
  const account = claudeAccountFromProfile(await fetchJson(fetchImpl, 'https://api.anthropic.com/api/oauth/profile', headers));
  await db.update(accountSecretResources)
    .set({ providerAccount: { email: account?.email ?? null, plan: account?.plan ?? null, checked_at: new Date().toISOString() } })
    .where(and(eq(accountSecretResources.secretId, row.secretId), eq(accountSecretResources.accountId, row.accountId)));
}

// replica-local: one provider read per login at a time on this replica.
const inflight = new Map<string, Promise<SubscriptionUsage | null>>();

/**
 * The login's current usage: the provider's answer when the last refresh is
 * over a minute old, else the stored snapshot. The minute is claimed in the
 * database first, so replicas and open tabs share one provider read.
 */
export async function refreshSubscriptionUsage(
  row: UsageRow, fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<SubscriptionUsage | null> {
  const stored = storedSubscriptionUsage(row.usage);
  if (!row.providerId || !SUBSCRIPTION_PROVIDERS.has(row.providerId)) return null;
  const due = new Date(Date.now() - REFRESH_EVERY_MS);
  if (row.usageCheckedAt && row.usageCheckedAt > due) return stored;
  const running = inflight.get(row.secretId);
  if (running) return running;
  const pending = (async () => {
    const [claimed] = await db.update(accountSecretResources).set({ usageCheckedAt: new Date() })
      .where(and(
        eq(accountSecretResources.secretId, row.secretId),
        eq(accountSecretResources.accountId, row.accountId),
        sql`coalesce(${accountSecretResources.usageCheckedAt}, '-infinity') <= ${due.toISOString()}::timestamptz`,
      ))
      .returning({ secretId: accountSecretResources.secretId });
    if (!claimed) return stored;
    try {
      const fresh = await providerUsage(row, fetchImpl);
      if (!fresh) return stored;
      await recordSubscriptionUsage(row.secretId, row.accountId, fresh);
      return fresh;
    } catch (error) {
      logger.warn('[subscription-usage] usage refresh failed', { secretId: row.secretId, error: error instanceof Error ? error.message : String(error) });
      return stored;
    }
  })().finally(() => inflight.delete(row.secretId));
  inflight.set(row.secretId, pending);
  return pending;
}
