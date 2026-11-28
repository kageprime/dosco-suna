/**
 * Claude Code passthrough: the model calls of Claude Code in a session's
 * sandbox, on a Claude account the project stores.
 *
 * Claude Code in the box has the gateway as its base URL and the session's
 * gateway token as its login. It sends Anthropic's own request:
 * `POST {base}/v1/messages?beta=true` with its subscription headers
 * (`anthropic-beta: claude-code-…,oauth-…`, `x-app: cli`, …), plus a
 * `HEAD {base}/api/hello` connectivity check. This handler:
 *
 *   1. authenticates the session token (the same principal as every model call);
 *   2. asks the host which Claude accounts this principal may use, in order;
 *   3. forwards the request body byte for byte to Anthropic, with only Claude
 *      Code's own headers and `Authorization: Bearer <account token>`;
 *   4. relays the response (status, type, stream) unchanged.
 *
 * A 429 rests that account and the request moves to the next one; a 401 marks
 * the account for reconnection and moves on; a 403 (Anthropic forbids the
 * account, for example when its organization turned Claude Code off) stores
 * Anthropic's reason on the account and moves on; a 403 that is not Anthropic's
 * error JSON (a proxy or firewall page) is relayed as received. When the last account was
 * forbidden, the host is asked again: it now skips the forbidden accounts and
 * answers why none is left, naming them. Every other response's plan usage
 * headers go to `notePoolUsage`. Nothing here translates the
 * request or logs a body. Only token counts are observed in transit. The account token
 * never leaves the gateway and the API.
 */
import { observeClaudeUsage } from './usage';
import type { TokenCounts, UsageEvent } from '../domain/usage';
import type { GatewayTrace } from '../domain/trace';
import { createHash } from 'node:crypto';
import type { AuthedPrincipal } from '../domain/principal';
import { upstreamFetch } from '../upstream-fetch';
import { type SubscriptionUsage, subscriptionUsageFromHeaders } from '../usage/subscription-usage';

export interface ClaudeCodeCredential {
  secretId: string;
  /** The account's `sk-ant-oat01-…` token. */
  apiKey: string;
}

export type ClaudeCodeCredentials =
  | { credentials: ClaudeCodeCredential[] }
  | { error: {
    status: number; code: string; message: string; suggestion?: string; retryAfterSeconds?: number;
    /** How long the first usable account still rests. Over a minute it is a plan usage limit. */
    restSeconds?: number;
  } };

export interface ClaudeCodeHooks {
  recordUsage?: (event: UsageEvent) => Promise<void>;
  recordTrace?: (trace: GatewayTrace) => Promise<void>;
  authenticate: (token: string) => Promise<AuthedPrincipal | null>;
  /** The Claude accounts the principal may use for `model` (Anthropic's model id), best first, or why none. */
  claudeCredentials: (principal: AuthedPrincipal, input: { model: string | null }) => Promise<ClaudeCodeCredentials>;
  /** Anthropic refused this account's token (401): the host marks it for reconnection. */
  claudeRefused?: (principal: AuthedPrincipal, secretId: string, failedKeySha256: string) => Promise<void>;
  /**
   * Anthropic forbade this account (403): the token is valid, but the account may not
   * run Claude Code, for example "Your organization has disabled Claude subscription
   * access for Claude Code". The host stores `message` (Anthropic's words) on the
   * account and skips the account for a while.
   */
  claudeForbidden?: (principal: AuthedPrincipal, secretId: string, failedKeySha256: string, message: string) => Promise<void>;
  notePoolRateLimit?: (principal: AuthedPrincipal, secretId: string, seconds: number) => Promise<void>;
  /** The plan usage this account's response reported (`anthropic-ratelimit-unified-*`). */
  notePoolUsage?: (principal: AuthedPrincipal, secretId: string, usage: SubscriptionUsage) => Promise<void>;
}

export interface ClaudeCodeRequest {
  method: string;
  /** The path after the passthrough prefix, starting with `/`: `/v1/messages`. */
  path: string;
  /** The query string with its `?`, or ''. */
  search: string;
  headers: Headers;
  body: Uint8Array | null;
  signal?: AbortSignal;
}

export interface ClaudeCodeDeps {
  /** Anthropic's API origin. Default https://api.anthropic.com. */
  upstream?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'warn'>;
}

const FORWARDED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const DEFAULT_REST_SECONDS = 60;

/** Claude Code's own request headers. Anything else (cookies, proxy headers, the Kortix token) stays here. */
function forwardedHeader(name: string): boolean {
  return name === 'content-type' || name === 'accept' || name === 'user-agent' || name === 'x-app' ||
    name.startsWith('anthropic-') || name.startsWith('x-claude-code-') || name.startsWith('x-stainless-');
}

/** Response headers that describe this hop, or bytes fetch already decoded. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'proxy-authenticate', 'set-cookie']);

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  429: 'rate_limit_error', 503: 'overloaded_error',
};

function anthropicError(status: number, message: string, retryAfterSeconds?: number, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (retryAfterSeconds) headers['retry-after'] = String(retryAfterSeconds);
  return new Response(JSON.stringify({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } }), { status, headers });
}

/** A rest longer than this is a plan usage limit, not a short rate limit (the API's `accountsResting`). */
const USAGE_LIMIT_MIN_REST_SECONDS = 60;
/**
 * The representative claim of a Kortix usage-limit 429. Claude Code reads a 429 as a usage limit
 * only when it carries `anthropic-ratelimit-unified-representative-claim`; without it, it prints
 * "Server is temporarily limiting requests (not your usage limit)" and retries. Anthropic's own
 * claims name a window (`five_hour`, `seven_day`, …). Kortix stores only when the account's rest
 * ends, so this claim names no window: Claude Code 0.3.x then prints
 * "You've hit your usage limit · resets <time>" and stops retrying.
 */
const KORTIX_USAGE_LIMIT_CLAIM = 'kortix_claude_accounts';

/** Every usable Claude account rests on its plan limit: answer the way Anthropic answers a usage limit. */
function usageLimitError(message: string, restSeconds: number): Response {
  const seconds = Math.ceil(restSeconds);
  return anthropicError(429, message, seconds, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': KORTIX_USAGE_LIMIT_CLAIM,
    'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + seconds),
  });
}

/** The host's reason no account can serve, in the Anthropic error shape Claude Code reads. */
function hostError(error: Extract<ClaudeCodeCredentials, { error: unknown }>['error']): Response {
  const { status, message, suggestion, retryAfterSeconds, restSeconds } = error;
  const text = suggestion ? `${message} ${suggestion}` : message;
  if (status === 429 && restSeconds !== undefined && restSeconds > USAGE_LIMIT_MIN_REST_SECONDS) return usageLimitError(text, restSeconds);
  return anthropicError(status, text, retryAfterSeconds);
}

/** The longest reason stored for a forbidden account (`verify_message` holds 500). */
const MAX_FORBIDDEN_MESSAGE = 300;

/**
 * Anthropic's words in its own 403 error body (`{"type":"error","error":{"message":…}}`),
 * on one line and capped, or null when the body is not Anthropic's error JSON. A
 * proxy or firewall page in front of Anthropic is not a refusal of the account.
 */
export function forbiddenMessage(body: string): string | null {
  type AnthropicError = { type?: unknown; error?: { message?: unknown } } | null;
  const parsed = ((): AnthropicError => {
    try {
      return JSON.parse(body) as AnthropicError;
    } catch {
      return null;
    }
  })();
  if (parsed?.type !== 'error' || typeof parsed.error?.message !== 'string') return null;
  const message = parsed.error.message.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  return message.length > MAX_FORBIDDEN_MESSAGE ? `${message.slice(0, MAX_FORBIDDEN_MESSAGE - 1)}…` : message;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The most of a 403 body the gateway reads: Anthropic's error JSON is under 1 KiB. */
const MAX_FORBIDDEN_BODY_BYTES = 64 * 1024;

/** A 403 body, at most `MAX_FORBIDDEN_BODY_BYTES`; the rest is cancelled, never buffered. */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_FORBIDDEN_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_FORBIDDEN_BODY_BYTES - size;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      size += Math.min(value.byteLength, room);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function sessionToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  return headers.get('x-api-key')?.trim() || null;
}

/** The request's `model`, read without keeping the parsed body. */
function requestModel(body: Uint8Array | null): string | null {
  if (!body) return null;
  try {
    const model = (JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }).model;
    return typeof model === 'string' ? model : null;
  } catch {
    return null;
  }
}

function restSeconds(response: Response): number {
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : DEFAULT_REST_SECONDS;
}

function relay(response: Response): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key)) headers.set(key, value);
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createClaudeCodePassthrough(hooks: ClaudeCodeHooks, deps: ClaudeCodeDeps = {}) {
  let upstream = deps.upstream ?? 'https://api.anthropic.com';
  while (upstream.endsWith('/')) upstream = upstream.slice(0, -1);
  const fetchImpl = deps.fetchImpl ?? upstreamFetch;
  const logger = deps.logger ?? console;

  return async (req: ClaudeCodeRequest): Promise<Response> => {
    if (req.path === '/api/hello') return new Response(null, { status: 200 });
    if (req.method !== 'POST' || !FORWARDED_PATHS.has(req.path)) return anthropicError(404, 'Not found');

    const token = sessionToken(req.headers);
    if (!token) return anthropicError(401, 'Missing Kortix session token');
    const principal = await hooks.authenticate(token);
    if (!principal) return anthropicError(401, 'Invalid Kortix session token');

    const startedAt = new Date().toISOString();
    const started = Date.now();
    const model = requestModel(req.body);
    const id = crypto.randomUUID();
    const found = await hooks.claudeCredentials(principal, { model });
    if ('error' in found) return hostError(found.error);

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (forwardedHeader(key)) headers.set(key, value);
    });
    const target = `${upstream}${req.path}${req.search}`;
    let last: Response | null = null;
    for (const [index, credential] of found.credentials.entries()) {
      headers.set('authorization', `Bearer ${credential.apiKey}`);
      const response = await fetchImpl(target, { method: 'POST', headers, body: req.body as BodyInit | null, signal: req.signal });
      const more = index < found.credentials.length - 1;
      if (response.status === 403) {
        // A forbidden account reports no plan usage: the host reads a usage
        // report as a served call and clears the account's 403 reason with it.
        const body = await boundedText(response).catch(() => '');
        const answer = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        const reason = forbiddenMessage(body);
        // Not Anthropic's refusal of this account (a proxy or firewall page): relayed as received.
        if (!reason) return relay(answer);
        await hooks.claudeForbidden?.(principal, credential.secretId, sha256(credential.apiKey), reason).catch((err) => {
          logger.warn('[claude-code] could not mark a forbidden Claude account', { secretId: credential.secretId, error: String(err) });
        });
        last = answer;
        if (!more) break;
        continue;
      }
      const usage = subscriptionUsageFromHeaders(response.headers);
      if (usage && hooks.notePoolUsage) void hooks.notePoolUsage(principal, credential.secretId, usage).catch(() => undefined);
      if (response.status === 429) {
        await hooks.notePoolRateLimit?.(principal, credential.secretId, restSeconds(response)).catch((err) => {
          logger.warn('[claude-code] could not record a Claude account rest', { secretId: credential.secretId, error: String(err) });
        });
      } else if (response.status === 401) {
        const digest = sha256(credential.apiKey);
        await hooks.claudeRefused?.(principal, credential.secretId, digest).catch((err) => {
          logger.warn('[claude-code] could not mark a refused Claude account', { secretId: credential.secretId, error: String(err) });
        });
      } else {
        const relayed = relay(response);
        if (!response.ok || req.path !== '/v1/messages') return relayed;
        return observeClaudeUsage(relayed, (usage) => {
          const resolved = usage.model ?? model ?? 'unknown';
          const alias = resolved.startsWith('claude-opus-') ? 'opus'
            : resolved.startsWith('claude-sonnet-') ? 'sonnet'
            : resolved.startsWith('claude-haiku-') ? 'haiku'
            : resolved.startsWith('claude-fable-') ? 'fable' : resolved;
          const servedModel = `claude-agent/${alias}`;
          const counts = { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
            cachedTokens: usage.cachedTokens, cacheWriteTokens: usage.cacheWriteTokens };
          const common: Omit<UsageEvent, keyof TokenCounts | 'model'> = { accountId: principal.accountId, actorUserId: principal.userId,
            projectId: principal.projectId, sessionId: principal.sessionId, provider: 'claude-agent',
            billingMode: 'none', streaming: response.headers.get('content-type')?.includes('text/event-stream') ?? false,
            requestId: id, upstreamCost: 0, finalCost: 0 };
          void hooks.recordUsage?.({ ...common, ...counts, model: servedModel, usageEstimated: !usage.complete })
            .catch((error) => logger.warn('[claude-code] usage recording failed', { error: String(error) }));
          void hooks.recordTrace?.({ ...common, startedAt, keyId: principal.keyId,
            requestedModel: servedModel, resolvedModel: resolved, servedModel,
            status: response.status, ok: usage.complete, latencyMs: Date.now() - started,
            attempts: index + 1, candidatesTried: ['claude-agent'], usage: counts,
            request: null, response: null, metadata: { usageEstimated: !usage.complete },
          }).catch((error) => logger.warn('[claude-code] trace recording failed', { error: String(error) }));
        });
      }
      if (!more) {
        last = response;
        break;
      }
      // Free the refused attempt's connection before the next one.
      await response.body?.cancel().catch(() => undefined);
    }
    if (last?.status === 403 && hooks.claudeForbidden) {
      // The last account was forbidden, and every earlier one failed too. The host
      // now skips the forbidden accounts: its answer names them, Anthropic's
      // reason and the fix, where Anthropic's own 403 names no account.
      const again = await hooks.claudeCredentials(principal, { model }).catch(() => null);
      if (again && 'error' in again) return hostError(again.error);
    }
    return last ? relay(last) : anthropicError(400, 'No Claude account is available.');
  };
}
