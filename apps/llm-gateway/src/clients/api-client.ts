import { TimeoutError } from '@kortix/llm-gateway';
import { ApiUnavailableError, createControlPlaneTransport, type ApiClientOptions, type ApiPingResult } from './control-plane-transport';
export { ApiUnavailableError, type ApiClientOptions, type ApiPingResult, type FetchLike } from './control-plane-transport';
import type { ReplayedResponse } from '../idempotency';
import {
  GatewayResolutionError,
  type AdmitResult,
  type NoUpstreamReasonCode,
  type AuthedPrincipal,
  type AuthorizeResult,
  type ClaudeCodeCredentials,
  type ClaudeCodeHooks,
  type GatewayTrace,
  type ListModelsOptions,
  type ModelCatalog,
  type ModelRouteInput,
  type ModelRoutePlan,
  type SubscriptionUsage,
  type UpstreamDescriptor,
  type UsageEvent,
} from '@kortix/llm-gateway';

export interface ApiClient {
  authenticate: (token: string) => Promise<AuthedPrincipal | null>;
  authorize: (token: string) => Promise<AuthorizeResult>;
  admit: (token: string, input: ModelRouteInput) => Promise<AdmitResult | null>;
  resolveRoute: (
    principal: AuthedPrincipal,
    input: ModelRouteInput,
  ) => Promise<ModelRoutePlan | null>;
  resolveUpstream: (principal: AuthedPrincipal, model: string) => Promise<UpstreamDescriptor[]>;
  notePoolRateLimit: (principal: AuthedPrincipal, secretId: string, seconds: number) => Promise<void>;
  notePoolUsage: (principal: AuthedPrincipal, secretId: string, usage: SubscriptionUsage) => Promise<void>;
  refreshCredential: (principal: AuthedPrincipal, descriptor: UpstreamDescriptor) => Promise<UpstreamDescriptor | null>;
  claudeCredentials: NonNullable<ClaudeCodeHooks['claudeCredentials']>;
  claudeRefused: NonNullable<ClaudeCodeHooks['claudeRefused']>;
  assertBillingActive: (accountId: string) => Promise<{ holdUsd?: number } | void>;
  assertBudget: (principal: AuthedPrincipal) => Promise<void>;
  recordUsage: (event: UsageEvent) => Promise<void>;
  /** The Idempotency-Key replay shared by every gateway replica (KRTX-4612). */
  getReplay: (key: string) => Promise<ReplayedResponse | null>;
  putReplay: (key: string, answer: ReplayedResponse) => Promise<void>;
  recordTrace: (trace: GatewayTrace) => Promise<void>;
  listModels: (principal: AuthedPrincipal, opts?: ListModelsOptions) => Promise<ModelCatalog>;
  ping: () => Promise<ApiPingResult>;
}

/** Calls the caller is waiting on — see `post`'s `retryOnTimeout`. */
const RETRY_SLOW = { retryOnTimeout: true } as const;

/** How long an API that answered 404 for `/admit` is not asked again. */
const ADMIT_MISSING_MS = 60_000;

/** How long a model's typed resolution refusal is remembered. Re-asking per request re-ran the API's resolution for the
 * same answer: a box's voice call resolves its TTS model once per spoken line, so one session against a deployment that
 * cannot serve the model re-failed every line (KRTX-4665: 27 warns in 8 h, one per line, one session). A refusal
 * without a retry hint is a persistent state (a lineup without the model, a plan gate, a disconnected provider, a
 * usage-limit rest); one with a retryAfterSeconds is transient and never memoized. The TTL picks a changed state up
 * without a gateway restart. */
const REFUSAL_MEMO_MS = 5 * 60 * 1000;
/** The refusal memo holds one entry per (account, project, caller, session, key, model id): bounded, oldest evicted. */
const REFUSAL_MEMO_MAX = 1_000;
/** A plausible model id: past this length the id is never remembered (the refusal message embeds it verbatim, so a memo
 * entry must stay bytes-small) and the memo key is lossy — two longer ids share one key. */
const MEMOIZABLE_MODEL_MAX = 200;

interface ResolutionErrorBody {
  code: NoUpstreamReasonCode;
  message: string;
  suggestion: string;
  retryAfterSeconds?: number;
  restSeconds?: number;
}

interface BillingBody {
  active: boolean;
  reason?: string;
  message?: string;
  holdUsd?: number;
}

function resolutionError({ code, message, suggestion, retryAfterSeconds, restSeconds }: ResolutionErrorBody) {
  return new GatewayResolutionError(code, message, suggestion, retryAfterSeconds, restSeconds);
}

/** `/billing`'s answer as `assertBillingActive` returns or throws it. */
function billingResult(result: BillingBody): { holdUsd?: number } | Error {
  if (!result.active) {
    const error = new Error(result.message ?? 'subscription required') as Error & { reason?: string };
    error.reason = result.reason ?? 'subscription_required';
    return error;
  }
  return result.holdUsd ? { holdUsd: result.holdUsd } : {};
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const { post, ping } = createControlPlaneTransport(opts);
  // ponytail: per-process memo; a mixed fleet mid-rollout can flip it once per minute.
  let admitMissingUntil = 0;

  // ponytail: per-process memo, like admitMissingUntil; each gateway task learns a refusal on its own first failure
  // (shared state only if that cost is measured). The key caps the model at the same 200 a model field is capped at
  // elsewhere (/claude-credentials), so an absurd id cannot pin its bytes in the process.
  const refusalMemo = new Map<string, { error: GatewayResolutionError; until: number }>();

  return {
    authenticate: async (token) => {
      const result = await post<{ principal: AuthedPrincipal | null }>(
        '/internal/gateway/authenticate',
        { token },
        RETRY_SLOW,
      );
      return result.principal ?? null;
    },
    authorize: async (token) => {
      return post<AuthorizeResult>('/internal/gateway/authorize', { token, deferBilling: true }, RETRY_SLOW);
    },
    // The gateway and the API roll out independently: an API without
    // `/admit` answers 404, and the handler then uses the separate calls.
    admit: async (token, input) => {
      if (Date.now() < admitMissingUntil) return null;
      let wire: {
        admission: AuthorizeResult;
        route?: ModelRoutePlan | null;
        candidates?: UpstreamDescriptor[];
        resolutionError?: ResolutionErrorBody;
        billing?: BillingBody;
        timing?: Record<string, number>;
      };
      // One attempt, never repeated: /admit debits the admission hold as its
      // last step, and a timeout, a reset connection or an edge 502/504 can
      // arrive after that debit. A repeat would debit again and only the last
      // hold would reach the gateway. Any of these answers null, and the
      // handler uses the separate calls; the worst case orphans one hold.
      // An API without /admit answers 404 and is not asked for a minute.
      try {
        wire = await post('/internal/gateway/admit', { token, input }, { once: true });
      } catch (error) {
        if (error instanceof TimeoutError) return null;
        if (error instanceof ApiUnavailableError) {
          if (error.status === 404) admitMissingUntil = Date.now() + ADMIT_MISSING_MS;
          if (error.status === undefined || error.status === 404 || error.status >= 500) return null;
        }
        throw error;
      }
      const result: AdmitResult = { admission: wire.admission };
      if (wire.route !== undefined) result.route = wire.route;
      if (wire.resolutionError) result.upstream = resolutionError(wire.resolutionError);
      else if (wire.candidates) result.upstream = wire.candidates;
      if (wire.billing) result.billing = billingResult(wire.billing);
      if (wire.timing) result.timing = wire.timing;
      return result;
    },
    // `input` crosses verbatim, `requires.imageOutput` included. A refusal
    // (an image request with no image model) comes back in a 200 body, as
    // /resolve-upstream's does, and is thrown as the typed error.
    resolveRoute: async (principal, input) => {
      const result = await post<{ route: ModelRoutePlan | null; resolutionError?: ResolutionErrorBody }>(
        '/internal/gateway/resolve-route',
        { principal, input },
        RETRY_SLOW,
      );
      if (result.resolutionError) throw resolutionError(result.resolutionError);
      return result.route ?? null;
    },
    resolveUpstream: async (principal, model) => {
      // A remembered refusal answers the same typed error the API would, without the round trip — and without re-arming
      // the API's per-replica warn gate for a deployment state that has not changed. A served answer is never remembered:
      // candidates change with plan and billing state. The key carries the caller (Strix review of this PR): resolution
      // is not project-grained alone — the personal connection (personalUserId: absent = the token user, null = none),
      // the session's provider pool (sessionId) and a project gateway key (keyId) all change the answer, and a refusal
      // can name the caller's own connection — one member's refusal never answers another member's request.
      const caller = principal.personalUserId === undefined ? principal.userId : principal.personalUserId;
      const key = `${principal.accountId}\u0000${principal.projectId ?? ''}\u0000${caller ?? ''}\u0000${principal.sessionId ?? ''}\u0000${principal.keyId ?? ''}\u0000${model.slice(0, MEMOIZABLE_MODEL_MAX)}`;
      // An oversized id is never answered from the memo either: a longer id that 200-prefix-matches a remembered one
      // shares its key, and the entry's message names the shorter id.
      const memoizable = model.length <= MEMOIZABLE_MODEL_MAX;
      const remembered = memoizable && refusalMemo.get(key);
      if (remembered) {
        if (Date.now() >= remembered.until) refusalMemo.delete(key);
        else throw remembered.error;
      }
      const result = await post<{
        candidates?: UpstreamDescriptor[];
        resolutionError?: ResolutionErrorBody;
      }>('/internal/gateway/resolve-upstream', { principal, model }, RETRY_SLOW);
      // The API catches GatewayResolutionError in /resolve-upstream and returns
      // it in a 200 body instead of letting it propagate as a 500 (which would
      // be captured to Sentry AND retried 3x here). Re-throw it as the typed
      // error so the pipeline's dispatch loop (handler.ts) sees the same
      // contract as the in-process hook (hooks.ts: resolveUpstream:
      // resolveCandidates) — a thrown GatewayResolutionError it can surface as
      // a clean 400 with the actionable suggestion, rather than a generic
      // ApiUnavailableError 5xx.
      if (result.resolutionError) {
        const error = resolutionError(result.resolutionError);
        // A refusal carrying retryAfterSeconds is TRANSIENT — a client-facing
        // retry hint that states when the refusal clears (a provider-pool
        // cooldown): never memoized, so the stated recovery is honored and no
        // stale retry-after is served past it. restSeconds is NOT a hint (the
        // client never receives it; a usage limit rests for days, outliving
        // this TTL): a restSeconds-only refusal stays memoized, the 5-min
        // re-ask being this fix's bound on per-line resolution. The memo keeps
        // the persistent codes (a lineup without the model, a plan gate, a
        // disconnected provider) the issue's signal needs.
        const transient = error.retryAfterSeconds !== undefined;
        if (!transient && memoizable) {
          // Map iteration is insertion order: the first key is the oldest entry (route-memory's bound).
          if (refusalMemo.size >= REFUSAL_MEMO_MAX) {
            const oldest = refusalMemo.keys().next().value;
            if (oldest !== undefined) refusalMemo.delete(oldest);
          }
          refusalMemo.set(key, { error, until: Date.now() + REFUSAL_MEMO_MS });
        }
        throw error;
      }
      return result.candidates ?? [];
    },
    notePoolRateLimit: async (principal, secretId, seconds) => {
      await post<{ ok: boolean }>('/internal/gateway/pool-rate-limit', { principal, secretId, seconds });
    },
    // Only the account id crosses: the API keys the snapshot by account and secret.
    notePoolUsage: async (principal, secretId, usage) => {
      await post<{ ok: boolean }>('/internal/gateway/pool-usage', { principal: { accountId: principal.accountId }, secretId, usage });
    },
    // The token itself never crosses back: the API compares a digest to tell
    // a login another request already refreshed from the one that failed.
    refreshCredential: async (principal, descriptor) => {
      if (!descriptor.credentialRef) return null;
      const failedKeySha256 = new Bun.CryptoHasher('sha256').update(descriptor.apiKey).digest('hex');
      const result = await post<{ descriptor: Partial<UpstreamDescriptor> | null }>('/internal/gateway/refresh-credential', {
        principal, secretId: descriptor.credentialRef, failedKeySha256,
      });
      return result.descriptor ? { ...descriptor, ...result.descriptor } : null;
    },
    // Claude Code passthrough. The account tokens cross this hop to the gateway
    // only; a refused one comes back as a digest, never the token.
    claudeCredentials: async (principal, input) => {
      return post<ClaudeCodeCredentials>('/internal/gateway/claude-credentials', { principal, model: input.model });
    },
    claudeRefused: async (principal, secretId, failedKeySha256) => {
      await post<{ ok: boolean }>('/internal/gateway/claude-refused', { principal, secretId, failedKeySha256 });
    },
    assertBillingActive: async (accountId) => {
      const result = billingResult(await post<BillingBody>('/internal/gateway/billing', { accountId }, RETRY_SLOW));
      if (result instanceof Error) throw result;
      return result.holdUsd ? result : undefined;
    },
    assertBudget: async (principal) => {
      // Admission evaluates 'block' budgets only. The API evaluates 'warn'
      // budgets after it writes the request's trace row (persistGatewayTrace).
      const result = await post<{ exceeded: boolean; message?: string }>(
        '/internal/gateway/budget-check',
        { principal },
        RETRY_SLOW,
      );
      if (result.exceeded) {
        throw new Error(result.message ?? 'Budget exceeded');
      }
    },

    recordUsage: async (event) => {
      await post<{ ok: boolean }>('/internal/gateway/usage', { event });
    },
    getReplay: async (key) => {
      const result = await post<{ answer: ReplayedResponse | null }>('/internal/gateway/idempotency/get', { key }, { once: true });
      return result.answer;
    },
    putReplay: async (key, answer) => {
      await post<{ ok: boolean }>('/internal/gateway/idempotency/put', { key, answer }, { once: true });
    },
    recordTrace: async (trace) => {
      await post<{ ok: boolean }>('/internal/gateway/trace', { trace });
    },
    listModels: async (principal, opts) => {
      const result = await post<{ models: ModelCatalog }>(
        '/internal/gateway/models',
        {
          principal,
          managedOnly: !!opts?.managedOnly,
          ...(opts?.scope ? { scope: opts.scope } : {}),
        },
        RETRY_SLOW,
      );
      return result.models ?? {};
    },
    ping,
  };
}
