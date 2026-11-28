import type {
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayLogger,
  TokenCounts,
  UsageEvent,
} from '../domain';
import { type NoUpstreamReasonCode } from '../errors';
import { type FetchImpl } from '../http';
import {
  type SseErrorFrame,
} from '../usage';
import { type ImageWindowOptions, isImagePart } from './image-window';
import type { RequestOrigin } from './request-origin';
import {
  type RouteMemory,
} from './route-memory';

export interface ChatCompletionRequest {
  authorization: string | undefined;
  rawBody: string;
  signal?: AbortSignal;
  /**
   * An already-parsed body, used by the Anthropic ingress.
   *
   * That ingress parses the raw body, translates it, and used to
   * `JSON.stringify` the result only for this handler to `JSON.parse` it
   * straight back. On an image-heavy request that round trip is the
   * difference between charging 3x the wire size and holding 5.03x
   * (measured 2026-08-24: 16 MiB of images -> +80.5 MiB on /v1/messages
   * versus +32.1 MiB on /chat/completions), which is how a single admitted
   * request could exceed the whole task's memory.
   */
  parsedBody?: Record<string, unknown>;
  /** The session message the request comes from (`request-origin.ts`). */
  origin?: RequestOrigin;
}

export interface GatewayDeps {
  fetchImpl?: FetchImpl;
  logger?: GatewayLogger;
  /** Inline-image cap per request. See pipeline/image-window.ts. */
  imageWindow?: ImageWindowOptions;
  /** Anthropic's origin for the Claude Code passthrough (claude-code/passthrough.ts). */
  claudeCodeUpstream?: string;
}

export interface HandlerRuntime {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  /** Routed models held per caller after they failed. See pipeline/route-memory.ts. */
  routeMemory?: RouteMemory;
  fetchImpl?: FetchImpl;
  imageWindow?: ImageWindowOptions;
}

export function streamErrorTraceStatus(error: SseErrorFrame): number {
  if (error.code === 'client_aborted') return 499;
  if (
    typeof error.code === 'number' &&
    Number.isInteger(error.code) &&
    error.code >= 400 &&
    error.code <= 599
  ) {
    return error.code;
  }
  return 502;
}

/**
 * Resolution failures a project's own fallback chain takes over, as the HTTP
 * status the same failure has from a provider: every own key or ChatGPT account
 * paused after a rate limit is a 429, a login that needs reconnection is a 401,
 * and a model that is unavailable here — retired, not served by this
 * deployment, or no longer recognized — is a 404, the status a provider answers
 * for a model it will not serve. The chain's retry setting then decides exactly
 * as for a failed attempt. Every other resolution failure (not connected,
 * disabled, excluded by the agent's grant) is a setup or policy answer and
 * stays the request's error.
 */
export const CHAIN_TAKES_OVER: Partial<Record<NoUpstreamReasonCode, number>> = {
  provider_pool_rate_limited: 429,
  provider_reauth_required: 401,
  model_not_found: 404,
  model_retired: 404,
  model_disabled_on_deployment: 404,
};

export const EMPTY_USAGE: TokenCounts = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
};

export function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S.*)$/i);
  return match ? match[1].trim() : null;
}

export function requestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function hasImage(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      return typeof (part as { type?: unknown }).type === 'string' && isImagePart(part);
    });
  });
}

// `ADMISSION_UNAVAILABLE` is a TRANSPORT failure of the admission gate itself
// (the standalone gateway's `authorize` hook is an HTTP call to the API control
// plane), not a denial. It is deliberately distinct from every `ok: false`
// verdict the gate can return: those mean "the caller may not run this", this
// one means "we could not find out".
export const ADMISSION_UNAVAILABLE = 'admission_unavailable';

/**
 * The answer to a wallet admission that failed (`assertBillingActive` or the
 * batched `admit` billing). A refusal carries its 402 code as `reason`. An
 * error without one is no verdict: the check timed out or the control plane
 * was unreachable. That is a retryable 503, never "no subscription" (prod
 * 2026-11-12: a 25 s control-plane stall answered funded accounts
 * `402 subscription_required "attempt 3 exceeded 5000ms"`, and their agents
 * reported "Out of credits").
 */
export function billingRefusal(error: unknown): { status: 402 | 503; code: string; message: string; suggestion: string; retryAfter?: number } {
  const reason = (error as { reason?: unknown })?.reason;
  if (typeof reason === 'string') {
    return {
      status: 402,
      code: reason,
      message: error instanceof Error ? error.message : 'Billing inactive',
      suggestion: 'Check your subscription or add credits, then retry.',
    };
  }
  return {
    status: 503,
    code: ADMISSION_UNAVAILABLE,
    message: 'Gateway admission control is unavailable',
    suggestion: 'Retry the request.',
    retryAfter: 5,
  };
}

export async function authorize(hooks: GatewayHooks, token: string): Promise<AuthorizeResult> {
  if (hooks.authorize) return hooks.authorize(token);
  const principal = await hooks.authenticate(token);
  if (!principal) {
    return { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
  }
  try {
    await hooks.assertBudget?.(principal);
    return { ok: true, principal };
  } catch (error) {
    const reason = (error as { reason?: unknown })?.reason;
    return {
      ok: false,
      status: 402,
      errorCode: typeof reason === 'string' ? reason : 'subscription_required',
      message: error instanceof Error ? error.message : 'Billing inactive',
      principal,
    };
  }
}

export function identity(principal: AuthedPrincipal) {
  return {
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    keyId: principal.keyId,
  };
}

export function refundHold(
  hooks: GatewayHooks,
  principal: AuthedPrincipal,
  logger: GatewayLogger,
): void {
  if (!principal.billingHold) return;
  const event: UsageEvent = {
    ...EMPTY_USAGE,
    accountId: principal.accountId,
    actorUserId: principal.userId,
    projectId: principal.projectId,
    sessionId: principal.sessionId,
    provider: '',
    model: 'unknown',
    upstreamCost: 0,
    finalCost: 0,
    billingMode: 'none',
    streaming: false,
    requestId: requestId(),
    billingHoldUsd: principal.billingHold.amountUsd,
  };
  // A failed refund leaves the caller's admission hold un-returned — small, but
  // it is the customer's money and an empty `.catch(() => {})` is how the last
  // billing blind spot stayed invisible for a whole period. Log it.
  void hooks.recordUsage(event).catch((error: unknown) => {
    logger.error('[gateway] admission-hold refund failed', {
      accountId: principal.accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Headers that describe the provider's WIRE framing, not its payload. `fetch`
// already decompressed the body and this gateway re-frames it (a relayed
// stream or a re-materialized string), so forwarding them lies to the next
// hop: the API reverse proxy's `fetch` saw `content-encoding: gzip` on a
// plaintext body and threw `ZlibError` on every non-streaming completion
// (local stack, 2026-08-24), and Caddy would hand the same pair straight to
// the client. Hop-by-hop headers (RFC 7230 §6.1) are dropped for the same
// reason.
const FRAMING_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
];

export function passthroughHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of FRAMING_HEADERS) headers.delete(name);
  return headers;
}
