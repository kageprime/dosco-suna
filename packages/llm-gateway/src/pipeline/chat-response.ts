import type {
  AuthedPrincipal,
  UpstreamDescriptor,
} from '../domain';
import { ClientAbortError, UpstreamHttpError } from '../errors';
import { callUpstream } from '../http';
import { parseUpstreamErrorBody } from '../http/parse-upstream-error';
import { upstreamFetch } from '../upstream-fetch';
import {
  chunkOutputChars,
  extractUsageFromJson,
} from '../usage';
import { breakerKey, tripsBreaker, upstreamBreakers } from './circuit-breaker';
import {
  type DispatchOutcome,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  rawProviderError,
  upstreamHeadersTimeoutMs,
  withUpstreamHeadersTimeout,
} from './dispatch';
import { clampRetryAfterSeconds, gatewayErrorResponse, providerClientErrorBody, providerFailureCode, requestTooLarge } from './error-response';
import {
  publicPayload,
  publicResponseHeaders,
  publicSseLines,
  publicUpstreamError,
  shownModel,
  shownProvider,
} from './public-identity';
import { createSettlement } from './settlement';
import { relayStream } from './streaming';
import { createTraceEmitter } from './trace';

import type { ChatCompletionRequest, HandlerRuntime } from './chat-shared';
import { identity, passthroughHeaders, refundHold } from './chat-shared';
interface ResponseInput {
  runtime: HandlerRuntime;
  req: ChatCompletionRequest;
  id: string;
  emit: ReturnType<typeof createTraceEmitter>;
  principal: AuthedPrincipal;
  requestedModel: string;
  routedModel: string;
  routeModel: string;
  streaming: boolean;
  promptTokenEstimate: number;
  cachedTokenEstimate: number;
  streamRedispatchBody: Record<string, unknown> | null;
  resolvedCandidates: UpstreamDescriptor[];
  sentRequestBytes: number;
  outcome: DispatchOutcome;
}
export async function respond(input: ResponseInput): Promise<Response> {
  const { runtime, req, id, emit, principal, requestedModel, routeModel, streaming, promptTokenEstimate, cachedTokenEstimate, streamRedispatchBody, resolvedCandidates, sentRequestBytes, outcome } = input;
  const { hooks, logger, fetchImpl } = runtime;
  let { routedModel } = input;
  // Mutable: a stream-cut transparent retry (below) can move this to the
  // candidate that actually answered the retry, exactly like dispatch()'s own
  // pool/profile/fallback moves already do.
  let served = outcome.descriptor;
  // The model that served, or failed last: a fallback model when the chain moved.
  routedModel = outcome.model;
  // Mutable: a stream-cut transparent retry (see `redispatchStream` below)
  // extends both when it re-dispatches, so the trace and billing records
  // reflect every attempt actually made, not just dispatch()'s own ladder.
  let attempts = outcome.attempts;
  let candidatesTried = outcome.candidatesTried;
  const { attemptFailures } = outcome;
  // Untried pool candidates of the SAME model, if any — "next pooled key"
  // gets first refusal on a stream-cut retry before re-dispatching the same
  // descriptor. Computed once `served` is known so it excludes whichever key
  // actually answered.
  const streamRedispatchCandidates: UpstreamDescriptor[] = served.poolSecretId
    ? resolvedCandidates.filter(
        (candidate) =>
          Boolean(candidate.poolSecretId) &&
          candidate.provider === served.provider &&
          candidate.poolSecretId !== served.poolSecretId,
      )
    : [];
  let streamRedispatchIndex = 0;
  // One stream-cut retry attempt against `candidate`. It reports its outcome
  // the way dispatch() does: to the candidate's circuit (success, failure or
  // release), to the pool cooldown on a 429, and to `attemptFailures`. A
  // non-2xx answer is a failed attempt (null), never the new SSE upstream.
  const redispatchTo = async (
    candidate: UpstreamDescriptor,
    lastOption: boolean,
  ): Promise<ReadableStream<Uint8Array> | null> => {
    const key = breakerKey(candidate, routedModel);
    const admitted = upstreamBreakers.allow(key);
    // An open circuit skips a pool peer; the last option is tried anyway.
    if (!admitted && !lastOption) return null;
    const admittedAt = upstreamBreakers.now();
    const failed = async (status: number | undefined, message: string, retryAfter?: string | null): Promise<null> => {
      if (tripsBreaker(status)) {
        upstreamBreakers.failure(key, {
          provider: candidate.provider,
          model: candidate.resolvedModel ?? routedModel,
          reason: status === undefined ? 'network_error' : String(status),
          publicListing: candidate.billingMode !== 'none',
        });
      } else if (admitted) upstreamBreakers.release(key);
      attempts += 1;
      candidatesTried = [...candidatesTried, `${candidate.provider}:stream-retry:${status ?? 'network_error'}`];
      const shown = candidate.publicProvider ? publicUpstreamError(status ?? 0, message, routedModel, sentRequestBytes) : null;
      attemptFailures.push({
        attempt: attemptFailures.length + 1,
        provider: shownProvider(candidate),
        routeModel: routedModel,
        resolvedModel: shownModel(candidate, routedModel),
        stage: 'dispatch',
        status,
        code: shown ? shown.code : status ?? 'network_error',
        message: shown ? shown.message : message,
      });
      logger.warn(`[gateway] ${id}: stream-cut redispatch to ${candidate.provider} failed (${status ?? 'network error'}): ${message.slice(0, 300)}`);
      if (status === 429 && candidate.poolSecretId && hooks.notePoolRateLimit) {
        try {
          await hooks.notePoolRateLimit(principal, candidate.poolSecretId, clampRetryAfterSeconds(retryAfter) ?? 30);
        } catch (error) {
          logger.error('[gateway] provider key cooldown could not be recorded', {
            secretId: candidate.poolSecretId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return null;
    };
    const timeoutMs = upstreamHeadersTimeoutMs(streamRedispatchBody!, candidate, true);
    let response: Response;
    try {
      response = await callUpstream(structuredClone(streamRedispatchBody!), candidate, {
        fetchImpl: withUpstreamHeadersTimeout(fetchImpl ?? upstreamFetch, timeoutMs),
        signal: req.signal,
        requestId: id,
      });
    } catch (error) {
      if (error instanceof ClientAbortError || req.signal?.aborted) {
        if (admitted) upstreamBreakers.release(key);
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      return failed(error instanceof UpstreamHttpError ? error.status : undefined, message);
    }
    if (!response.ok) {
      const message = (await response.text().catch(() => '')).slice(0, 500);
      return failed(response.status, message, response.headers.get('retry-after'));
    }
    if (!response.body) {
      if (admitted) upstreamBreakers.release(key);
      return null;
    }
    upstreamBreakers.success(key, admittedAt);
    // Attribute whatever gets billed/logged from here on to the candidate
    // that actually answered, exactly like dispatch()'s own retries do.
    served = candidate;
    attempts += 1;
    candidatesTried = [...candidatesTried, `${candidate.provider}:stream-retry`];
    return response.body;
  };
  // Pool peers first, then the served descriptor again. A failed peer moves
  // to the next one within the same retry; the served descriptor ends it.
  const redispatchStream = async (): Promise<ReadableStream<Uint8Array> | null> => {
    if (!streamRedispatchBody) return null;
    for (;;) {
      const lastOption = streamRedispatchIndex >= streamRedispatchCandidates.length;
      const candidate = streamRedispatchCandidates[streamRedispatchIndex] ?? served;
      streamRedispatchIndex += 1;
      const body = await redispatchTo(candidate, lastOption);
      if (body || lastOption || req.signal?.aborted) return body;
    }
  };
  if (!outcome.response) {
    const { error } = outcome;
    refundHold(hooks, principal, logger);
    const errorText =
      error instanceof UpstreamHttpError
        ? `${error.message} ${error.body}`
        : error instanceof Error ? error.message : String(error);
    const publicError = served.publicProvider
      ? publicUpstreamError(error instanceof UpstreamHttpError ? error.status : 0, errorText, routedModel, sentRequestBytes)
      : null;
    // An own provider's refusal is the customer's to read: the trace keeps its text, not "upstream HTTP 400".
    const providerFailure =
      !publicError && error instanceof UpstreamHttpError && error.status < 500 && error.status !== 429
        ? (requestTooLarge(error.status, error.body, sentRequestBytes) ?? {
            code: providerFailureCode(error.status) ?? 'upstream_error',
            message: parseUpstreamErrorBody(error.body, error.message).message.slice(0, 500),
          })
        : null;
    if (publicError) {
      logger.warn(
        `[gateway] ${id}: ${served.provider} failed for ${served.resolvedModel ?? routedModel}: ${errorText.slice(0, 300)}`,
      );
    }
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: shownModel(served, routedModel),
      provider: shownProvider(served),
      ...(served.publicProvider
        ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
        : {}),
      billingMode: served.billingMode,
      streaming,
      status: publicError?.status ?? (error instanceof UpstreamHttpError ? error.status : 502),
      ok: false,
      errorCode: publicError?.code ?? providerFailure?.code ?? 'upstream_error',
      errorMessage: publicError?.message ?? providerFailure?.message ?? (error instanceof Error ? error.message : String(error)),
      attempts,
      candidatesTried,
      attemptFailures,
    });
    if (publicError) {
      return gatewayErrorResponse(publicError.status, {
        message: publicError.message,
        code: publicError.code,
        provider: shownProvider(served),
        requestedModel,
        resolvedModel: routedModel,
        requestId: id,
        suggestion: publicError.suggestion,
        retryAfterSeconds:
          error instanceof UpstreamHttpError ? clampRetryAfterSeconds(error.headers?.['retry-after']) : undefined,
      });
    }
    if (error instanceof UpstreamHttpError) return rawProviderError(error, sentRequestBytes);
    // A headers timeout is "try again", not "this request is malformed".
    const timedOut = (error as { name?: unknown })?.name === 'TimeoutError' && !req.signal?.aborted;
    if (timedOut)
      return gatewayErrorResponse(503, {
        message: `Provider ${served.provider} sent no response headers within ${UPSTREAM_HEADERS_TIMEOUT_MS}ms`,
        code: 'upstream_timeout',
        provider: served.provider,
        requestedModel,
        resolvedModel: served.resolvedModel ?? routedModel,
        requestId: id,
        suggestion: 'Retry the request, or choose another model.',
      });
    return gatewayErrorResponse(502, {
      message: error instanceof Error ? error.message : 'Provider request failed',
      code: 'upstream_error',
      provider: served.provider,
      requestedModel,
      resolvedModel: served.resolvedModel ?? routedModel,
      requestId: id,
      suggestion: 'Retry the request or choose another model.',
    });
  }
  const upstream = outcome.response;

  // Set when an upstream answered non-2xx: the trace records the error the
  // client received (the public one for a managed model).
  let publicFailure: { status: number; code: string; message: string } | null = null;
  const settle = createSettlement(
    { hooks, logger, id, emit, principal, requestedModel, routedModel, routeModel, streaming, promptTokenEstimate, cachedTokenEstimate, upstream, attemptFailures },
    () => ({ served, attempts, candidatesTried, publicFailure }),
  );

  if (served.publicProvider && !upstream.ok) {
    const upstreamText = await upstream.text().catch(() => '');
    logger.warn(
      `[gateway] ${id}: ${served.provider} ${upstream.status} for ${served.resolvedModel ?? routedModel}: ${upstreamText.slice(0, 300)}`,
    );
    const classified = publicUpstreamError(upstream.status, upstreamText, routedModel, sentRequestBytes);
    publicFailure = classified;
    await settle(null);
    return gatewayErrorResponse(classified.status, {
      message: classified.message,
      code: classified.code,
      provider: shownProvider(served),
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: classified.suggestion,
      retryAfterSeconds: clampRetryAfterSeconds(upstream.headers.get('retry-after')),
    });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => '');
    // The trace records the refusal the client receives, with the provider's
    // own text. A 429 or 5xx reaches the client unchanged, as before; it is
    // read here so its trace row names the failure (it was blank before).
    const clientError = upstream.status < 500 && upstream.status !== 429;
    publicFailure = {
      status: upstream.status,
      ...((clientError ? requestTooLarge(upstream.status, upstreamText, sentRequestBytes) : null) ?? {
        code: providerFailureCode(upstream.status) ??
          (upstream.status === 429 ? 'upstream_rate_limited' : upstream.status >= 500 ? 'upstream_unavailable' : 'upstream_error'),
        message: parseUpstreamErrorBody(upstreamText, `upstream HTTP ${upstream.status}`).message.slice(0, 500),
      }),
    };
    await settle(null);
    const headers = passthroughHeaders(upstream.headers);
    if (clientError) headers.set('content-type', 'application/json');
    return new Response(
      clientError ? providerClientErrorBody(upstream.status, upstreamText, sentRequestBytes, served.provider) : upstreamText,
      { status: upstream.status, headers },
    );
  }

  // KRTX-3369: an answer names the model the client asked for and the model
  // that served it. A project chain that stood in for the requested model
  // (an unknown or retired name, a resting pool) is otherwise invisible.
  // A name a header cannot carry is left out rather than failing the answer.
  const nameModels = (headers: Headers): Headers => {
    for (const [name, value] of [['x-kortix-requested-model', requestedModel], ['x-kortix-model', routedModel]] as const) {
      if (/^[\x20-\x7e]{1,200}$/.test(value)) headers.set(name, value);
    }
    return headers;
  };

  if (streaming && upstream.body) {
    return new Response(
      relayStream({
        upstreamBody: upstream.body,
        requestId: id,
        upstreamProvider: served.provider,
        upstreamModel: served.resolvedModel ?? routedModel,
        logger,
        signal: req.signal,
        settle,
        // A non-2xx upstream "stream" is an arbitrary error body, not SSE —
        // never classify it as incomplete or retry it (see `treatAsSse`'s doc
        // comment in streaming.ts). This branch already excluded the
        // `served.publicProvider && !upstream.ok` case above, but a BYOK/
        // non-public-provider descriptor can still reach here non-2xx.
        treatAsSse: upstream.ok,
        redispatch: upstream.ok && streamRedispatchBody ? redispatchStream : undefined,
        ...(served.publicProvider
          ? { rewriteLines: (text: string) => publicSseLines(text, routedModel) }
          : {}),
      }),
      {
        status: upstream.status,
        headers: nameModels(served.publicProvider
          ? publicResponseHeaders(upstream.headers)
          : passthroughHeaders(upstream.headers)),
      },
    );
  }

  let responseText: string;
  try {
    responseText = await upstream.text();
  } catch (error) {
    // The provider answered 200 and bills for the prompt. A connection reset
    // while reading the body must not leave a request with no usage row and no
    // refund: settle the prompt estimate, then fail the request as before.
    if (upstream.ok) await settle(null, null, { outputChars: 0, clientStopped: true });
    throw error;
  }
  const data = (() => {
    try {
      return JSON.parse(responseText) as unknown;
    } catch {
      return null;
    }
  })();
  const reportedUsage = (data as { usage?: unknown } | null)?.usage;
  if (upstream.ok && (reportedUsage == null || typeof reportedUsage !== 'object')) {
    // A 200 with no usage object still generated output the provider bills.
    // Settle the estimate, never zero.
    const choices = (data as { choices?: Array<{ message?: unknown }> } | null)?.choices;
    const outputChars = Array.isArray(choices)
      ? chunkOutputChars({ choices: choices.map((choice) => ({ delta: choice?.message })) })
      : 0;
    await settle(null, null, { outputChars, clientStopped: false });
  } else {
    await settle(extractUsageFromJson(data));
  }
  if (served.publicProvider) {
    const publicText =
      data && typeof data === 'object' && !Array.isArray(data)
        ? JSON.stringify(publicPayload(data as Record<string, unknown>, routedModel))
        : responseText;
    return new Response(publicText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: nameModels(publicResponseHeaders(upstream.headers)),
    });
  }
  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: nameModels(passthroughHeaders(upstream.headers)),
  });
}
