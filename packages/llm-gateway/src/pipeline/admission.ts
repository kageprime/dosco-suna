import type {
  AdmitResult,
  AuthorizeResult,
} from '../domain';
import { gatewayErrorResponse } from './error-response';
import { DEFAULT_IMAGE_WINDOW, applyImageWindow } from './image-window';
import { conversationError, requestFieldError } from './request-fields';
import { createTraceEmitter } from './trace';

import type { ChatCompletionRequest, HandlerRuntime } from './chat-shared';
import { ADMISSION_UNAVAILABLE, authorize, bearer, hasImage, identity, refundHold, requestId } from './chat-shared';
export async function admitChat(runtime: HandlerRuntime, req: ChatCompletionRequest) {
  const { hooks, logger } = runtime;
  const imageWindow = runtime.imageWindow ?? DEFAULT_IMAGE_WINDOW;
  const id = requestId();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const emit = createTraceEmitter(hooks, logger, id, startedAt, startedMs, req.origin);

  const token = bearer(req.authorization);
  if (!token) {
    return gatewayErrorResponse(401, {
      message: 'Missing bearer token',
      code: 'missing_token',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Provide a valid gateway key or account token.',
    });
  }

  // Every other hook this handler calls has its failure classified —
  // resolveRoute -> 502 `routing_unavailable`, resolveUpstream -> 400,
  // billing/budget -> 402. `authorize` did not, so a control-plane transport
  // failure (a timed-out or unreachable API) threw straight out of the whole
  // pipeline and was served by the host's catch-all as an opaque
  // `503 gateway_error "Gateway unavailable"` with empty model fields —
  // indistinguishable from a gateway crash, and the reason the GW-ACCESS-1
  // release-gate flake read as a product bug for two releases. Same 503 the
  // caller already got; now it says which hop failed, and it says so in the
  // gateway's own error envelope with a `retry-after`.
  // `body` is the ONLY reference to the parsed request graph from here on.
  // It is nulled the moment dispatch has taken it (below), so a slow
  // time-to-first-byte upstream does not pin one extra copy of a multi-MB
  // multimodal request for the whole prefill. Parsed before admission so one
  // `admit` call can carry the model; invalid JSON is answered after
  // admission, so an unauthenticated caller still gets its 401 first.
  let body: Record<string, unknown> | null = null;
  // Rough (UTF-16 code units, not bytes — close enough for a size gate)
  // request size, captured before `rawBody` is cleared below. Used only to
  // decide whether a stream-cut transparent retry may afford ANOTHER
  // `structuredClone` of the body — see `streamRedispatchBody` below.
  const approxRequestSize = req.rawBody?.length ?? 0;
  // What the provider receives after the image window: what decides `request_too_large`.
  let sentRequestBytes = approxRequestSize;
  try {
    body = req.parsedBody ?? (JSON.parse(req.rawBody) as Record<string, unknown>);
  } catch {
    // answered after admission
  }
  req.parsedBody = undefined;
  req.rawBody = '';
  if (body) {
    const window = applyImageWindow(body, imageWindow);
    sentRequestBytes = Math.max(0, approxRequestSize - (window.bytes - window.keptBytes));
    if (window.dropped > 0) {
      logger.info(
        `[gateway] image window ${id}: kept ${window.total - window.dropped} of ${window.total} inline images (${window.keptBytes} of ${window.bytes} bytes)`,
      );
    }
  }
  const requestedModel = typeof body?.model === 'string' ? body.model : '';
  const routedModel = requestedModel;
  // Reused below to decide whether a stream-cut transparent retry may afford
  // ANOTHER `structuredClone` of the body — see `streamRedispatchBody`.
  const requestHasImage = body ? hasImage(body) : false;
  const routeInput = { requestedModel, requires: { imageInput: requestHasImage } };

  let admission: AuthorizeResult;
  // One control-plane round trip for authorize + route + primary resolve +
  // billing, when the host offers it. Each missing answer runs its own hook.
  let prefetched: AdmitResult | null = null;
  try {
    prefetched = body && hooks.admit ? await hooks.admit(token, routeInput) : null;
    if (prefetched?.timing) emit.admitSteps(prefetched.timing);
    admission = prefetched?.admission ?? await authorize(hooks, token);
  } catch (error) {
    // No principal exists yet, so there is nothing to refund and no account to
    // attribute a trace to — and `recordTrace` is another call to the control
    // plane this request just failed to reach. Log it and answer.
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`[gateway] ${id}: admission control unavailable — ${detail}`);
    return gatewayErrorResponse(503, {
      message: 'Gateway admission control is unavailable',
      code: ADMISSION_UNAVAILABLE,
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Retry the request.',
      retryAfterSeconds: 5,
    });
  }
  if (!admission.ok) {
    // A valid token a later gate refused is still a request: record it in usage
    // and logs (KRTX-1749). A 401 without a principal has no account to
    // attribute — the log store requires one, so nothing is recorded there.
    if (admission.principal) {
      emit({
        ...identity(admission.principal),
        status: admission.status,
        ok: false,
        errorCode: admission.errorCode,
        errorMessage: admission.message,
      });
    }
    return gatewayErrorResponse(admission.status, {
      message: admission.message ?? 'Request denied',
      code: admission.errorCode,
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Check authentication, billing, and budget settings.',
    });
  }
  let principal = admission.principal;
  // The admit call already debited this hold in the API. Put it on the
  // principal now, so every exit settles or refunds it, including a held
  // route that serves an own-key fallback and never reaches admitCharge.
  const prefetchedHold = prefetched?.billing instanceof Error ? undefined : prefetched?.billing?.holdUsd;
  if (prefetchedHold) principal = { ...principal, billingHold: { amountUsd: prefetchedHold } };
  emit.mark('admitted');

  if (!body) {
    refundHold(hooks, principal, logger);
    emit({
      ...identity(principal),
      status: 400,
      ok: false,
      errorCode: 'invalid_json',
      errorMessage: 'Invalid JSON body',
    });
    return gatewayErrorResponse(400, {
      message: 'Invalid JSON body',
      code: 'invalid_json',
      provider: '',
      requestedModel: '',
      resolvedModel: '',
      requestId: id,
      suggestion: 'Send one valid JSON request body.',
    });
  }

  const fieldError = requestFieldError(body) ?? conversationError(body);
  if (fieldError) {
    refundHold(hooks, principal, logger);
    emit({
      ...identity(principal),
      requestedModel,
      status: 400,
      ok: false,
      errorCode: 'invalid_request',
      errorMessage: fieldError,
    });
    return gatewayErrorResponse(400, {
      message: fieldError,
      code: 'invalid_request',
      provider: '',
      requestedModel,
      resolvedModel: '',
      requestId: id,
      suggestion: 'Fix the field and retry.',
    });
  }

  return { body, id, emit, principal, prefetched, requestedModel, routedModel, requestHasImage, routeInput, approxRequestSize, sentRequestBytes };
}
