import type {
  AdmitResult,
  AuthedPrincipal,
  AuthorizeResult,
  GatewayHooks,
  GatewayLogger,
  GatewayTrace,
} from '../domain';
import { type GatewayErrorContext, gatewayErrorBody, gatewayErrorResponse } from './error-response';
import { authorize, identity, refundHold, type HandlerRuntime } from './simple-handler';
import type { TraceEmitter, TraceFields } from './trace';

/**
 * Why one request did not answer: the one refusal shape both the audio and the
 * image handlers pass around. A candidate failure becomes one of these; the
 * shared `refuse` turns it into the trace and the envelope.
 */
interface Refusal {
  status: number;
  code: string;
  message: string;
  suggestion: string;
  retryAfter?: number;
  headers?: Record<string, string>;
}
export type { Refusal };

/** What an error envelope names: the request id and the model naming, read at refusal time. */
export interface RefusalSite {
  id: string;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
}

/** One request's state that `refuse` needs: the hold's owner, its trace and its naming. */
export interface RefusalRun {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  principal: AuthedPrincipal;
  /** The surface's own trace: `traceRefusal` redacts it. */
  trace(fields: TraceFields): void;
  readonly site: RefusalSite;
  /** The envelope refusals serialize through: the canonical `refusalResponse` when the surface carries none. */
  readonly wire?: RefusalWire;
}

/** A request with no bearer token, before anything else runs. */
export const MISSING_TOKEN: Refusal = {
  status: 401,
  code: 'missing_token',
  message: 'Missing bearer token',
  suggestion: 'Provide a valid gateway key or account token.',
};

/**
 * What an error envelope names, before a wire chooses where `retry_after`
 * goes — read at refusal time from the surface's own naming.
 */
function refusalContext(at: RefusalSite, refusal: Refusal): Omit<GatewayErrorContext, 'responseStatus' | 'retryAfterSeconds'> {
  return {
    message: refusal.message,
    code: refusal.code,
    provider: at.provider,
    requestedModel: at.requestedModel,
    resolvedModel: at.resolvedModel,
    requestId: at.id,
    suggestion: refusal.suggestion,
  };
}

/** One refusal envelope. Either a surface's own wire, or the canonical one below. */
export type RefusalWire = (at: RefusalSite, refusal: Refusal) => Response;

/**
 * The canonical refusal envelope: the gateway error body (with its below-500
 * status gate), the `retry_after` body field and the `retry-after` header
 * together, and any per-refusal headers — an image limit's reset headers —
 * relayed on top. The image surface's wire.
 */
export function refusalResponse(at: RefusalSite, refusal: Refusal): Response {
  const { status, retryAfter } = refusal;
  const body = gatewayErrorBody({
    ...refusalContext(at, refusal),
    responseStatus: status,
  });
  return new Response(JSON.stringify(retryAfter !== undefined ? { ...body, retry_after: retryAfter } : body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
      ...refusal.headers,
    },
  });
}

/**
 * The audio surface's wire, kept through the move from its deleted
 * `errorResponse`: the canonical `gatewayErrorResponse` builder, whose
 * `retry-after` lives in the header alone — clamped, never a body field, and
 * no per-refusal header spread. Two surfaces, two wire contracts; a refusal
 * serializes through exactly one of these.
 */
export function audioRefusalResponse(at: RefusalSite, refusal: Refusal): Response {
  return gatewayErrorResponse(refusal.status, { ...refusalContext(at, refusal), retryAfterSeconds: refusal.retryAfter });
}

/** The one trace both surfaces emit: the surface's fields over the caller's, never a payload. */
export function traceRefusal(
  emit: TraceEmitter,
  principal: AuthedPrincipal,
  operation: string,
  base: Partial<GatewayTrace>,
  fields: TraceFields,
): void {
  emit({
    ...identity(principal),
    ...base,
    ...fields,
    // Never the request's or the answer's payload: no prompt, no image
    // bytes, no audio, no transcript.
    request: null,
    response: null,
    metadata: { operation },
  });
}

/** Every unanswered exit after admission: return any wallet hold, trace, answer. */
export function refuse(run: RefusalRun, refusal: Refusal): Response {
  refundHold(run.hooks, run.principal, run.logger);
  run.trace({ status: refusal.status, ok: false, errorCode: refusal.code, errorMessage: refusal.message });
  return (run.wire ?? refusalResponse)(run.site, refusal);
}

/** A stopped client or the request's time budget ends it. */
export function stopped(
  run: { clientSignal?: AbortSignal; signal: AbortSignal },
  timeout: { code: string; message: string },
): Refusal | null {
  if (run.clientSignal?.aborted) {
    return { status: 499, code: 'client_aborted', message: 'The client cancelled the request.', suggestion: 'Retry the request.' };
  }
  if (run.signal.aborted) {
    return { status: 504, code: timeout.code, message: timeout.message, suggestion: 'Retry the request.' };
  }
  return null;
}

/** The admission gate itself failed (a transport failure, not a denial): log it, ask for a short retry. */
export function admissionUnavailable(
  site: RefusalSite,
  logger: GatewayLogger,
  error: unknown,
  /** The refusal's wire: audio surfaces pass `audioRefusalResponse`. */
  wire: RefusalWire = refusalResponse,
): Response {
  logger.error(`[gateway] ${site.id}: admission control unavailable — ${error instanceof Error ? error.message : String(error)}`);
  return wire(site, {
    status: 503,
    code: 'admission_unavailable',
    message: 'Gateway admission control is unavailable',
    suggestion: 'Retry the request.',
    retryAfter: 5,
  });
}

/**
 * The admission ladder every billed request walks: the bearer token, the
 * account, and — when the gate says no — the denial traced and enveloped. The
 * host's batched `admit` answer, when the surface takes one, is fetched inside
 * the gate's protection: its failure is the same admission_unavailable refusal.
 */
export async function admitOrRefuse(
  runtime: HandlerRuntime,
  token: string | null,
  options: {
    /** The trace operation the denial names: `audio.speech`, `images.generations`. */
    operation: string;
    /** What every refusal envelope of the ladder names. */
    site: RefusalSite;
    emit: TraceEmitter;
    /** The denial trace's requested model, when the body named one before admission. */
    requestedModel?: string;
    /** The host's batched admission, taken inside the gate's protection. */
    prefetch?: (token: string) => Promise<AdmitResult | null>;
    /** The refusal's wire: audio surfaces pass `audioRefusalResponse`. */
    wire?: RefusalWire;
  },
): Promise<{ admission: Extract<AuthorizeResult, { ok: true }>; prefetched: AdmitResult | null } | Response> {
  const wire = options.wire ?? refusalResponse;
  if (!token) return wire(options.site, MISSING_TOKEN);
  const { hooks, logger } = runtime;
  try {
    const prefetched = options.prefetch ? await options.prefetch(token) : null;
    if (prefetched?.timing) options.emit.admitSteps(prefetched.timing);
    const admission = prefetched?.admission ?? (await authorize(hooks, token));
    if (!admission.ok) {
      const message = admission.message ?? 'Request not allowed';
      if (admission.principal) {
        traceRefusal(options.emit, admission.principal, options.operation, { requestedModel: options.requestedModel }, {
          status: admission.status,
          ok: false,
          errorCode: admission.errorCode,
          errorMessage: message,
        });
      }
      return wire(options.site, {
        status: admission.status,
        code: admission.errorCode,
        message,
        suggestion: 'Sign in again or check the account, then retry.',
      });
    }
    return { admission, prefetched };
  } catch (error) {
    return admissionUnavailable(options.site, logger, error, wire);
  }
}

/**
 * The wallet admission for a Kortix-billed request: the admit answer when the
 * host batched it, else `assertBillingActive`. A taken hold lands on the
 * principal, settled with the usage event or returned by `refuse`.
 */
export async function ensureBillingHold(
  run: { hooks: GatewayHooks; principal: AuthedPrincipal },
  prefetched?: AdmitResult | null,
): Promise<Refusal | null> {
  if (run.principal.billingHold) return null;
  try {
    const answered = prefetched?.billing;
    if (answered instanceof Error) throw answered;
    const billing = answered ?? (await run.hooks.assertBillingActive(run.principal.accountId));
    if (billing?.holdUsd) run.principal = { ...run.principal, billingHold: { amountUsd: billing.holdUsd } };
    return null;
  } catch (error) {
    const reason = (error as { reason?: unknown })?.reason;
    return {
      status: 402,
      code: typeof reason === 'string' ? reason : 'subscription_required',
      message: error instanceof Error ? error.message : 'Billing inactive',
      suggestion: 'Check your subscription or add credits, then retry.',
    };
  }
}
