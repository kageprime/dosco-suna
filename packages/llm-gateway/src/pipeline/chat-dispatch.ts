import { upstreamFetch } from '../upstream-fetch';
import {
  estimateCachedPromptTokens,
  estimatePromptTokens,
} from '../usage';
import {
  type DispatchOutcome,
  dispatch,
} from './dispatch';
import {
  DISPATCH_HOLD_SECONDS,
} from './route-memory';
import type { routeChat } from './routing';

import { admitChat } from './admission';
import type { ChatCompletionRequest, HandlerRuntime } from './chat-shared';

export async function dispatchChat(
  runtime: HandlerRuntime,
  req: ChatCompletionRequest,
  admitted: Omit<Exclude<Awaited<ReturnType<typeof admitChat>>, Response>, 'body'>,
  routed: Exclude<Awaited<ReturnType<typeof routeChat>>, Response>,
  inputBody: Record<string, unknown>,
) {
  let body: Record<string, unknown> | null = inputBody;
  inputBody = {};
  const { hooks, logger, fetchImpl, routeMemory } = runtime;
  const { id, emit, requestHasImage, approxRequestSize } = admitted;
  const { route, routeModel, fallbackChosenByProject, memoryKey, descriptor, resolvedCandidates, chain, unavailable, chargeAdmitted } = routed;
  const { routedModel } = routed;
  const streaming = body.stream === true;
  if (streaming) body.stream_options = { include_usage: true };
  // A BYOK request is billable too when the project's chain can move it to a
  // Kortix-billed model.
  const billable = descriptor.billingMode !== 'none' || (fallbackChosenByProject && Boolean(chain?.length));
  // Measured now, while the parsed body still exists: a billable stream that
  // ends before its usage frame is settled from this (see usage/estimate.ts).
  const promptTokenEstimate = billable ? estimatePromptTokens(body) : 0;
  const cachedTokenEstimate = estimateCachedPromptTokens(body, promptTokenEstimate);
  // Kept only so a STREAMING body that gets cut before a single byte reaches
  // the client can be transparently retried (see relayStream's `redispatch`
  // option / streaming.ts's `handleIncompleteTermination`). dispatch() owns
  // the parsed graph from here on (nulled below) and never retries once its
  // OWN attempt has produced output, so this covers the one case it
  // deliberately leaves alone: a cut AFTER a successful dispatch.
  //
  // A held clone for the whole streaming response lifetime is exactly the
  // "unbounded per-request memory" class this codebase has paid for
  // repeatedly (see memory-envelope.test.ts, 2026-08-22). Clone fresh only
  // for a body small enough that doing so is cheap; an inline-image-bearing
  // or otherwise large multimodal request gets no transparent retry — it
  // still gets the other two halves of this fix (never forward a partial
  // line, explicit terminal error frame) and falls straight to the error
  // frame on a cut instead of retrying first.
  const STREAM_REDISPATCH_MAX_BODY_SIZE = 256 * 1024;
  const streamRedispatchBody: Record<string, unknown> | null =
    streaming && !requestHasImage && approxRequestSize <= STREAM_REDISPATCH_MAX_BODY_SIZE
      ? structuredClone(body)
      : null;
  /**
   * Keeps this outcome for the caller's next request: a transient failure of
   * the routed model that a fallback answered holds the route, and the routed
   * model answering releases it.
   */
  const holdAfterDispatch = (outcome: DispatchOutcome) => {
    if (outcome.model === routeModel) return routeMemory?.release(memoryKey);
    // The plan started at a fallback: its hold was set when the routed model failed.
    if (unavailable) return;
    const failure = outcome.attemptFailures.filter((attempt) => attempt.routeModel === routeModel).at(-1);
    const transient = failure && (failure.status === undefined || failure.status === 429 || failure.status >= 500);
    if (!transient) return;
    routeMemory?.hold(memoryKey, {
      fallbackModel: outcome.model,
      failure,
      byok: resolvedCandidates[0]?.billingMode === 'none',
    }, DISPATCH_HOLD_SECONDS);
  };
  emit.mark('dispatch');
  const pending = dispatch(
    body,
    {
      model: routedModel,
      candidates: resolvedCandidates,
      fallbackModels: chain,
      fallbackOn: route?.fallbackOn,
      fallbackChosenByProject,
      // A fallback model gets its own clamped defaults, never the primary's.
      defaultsFor: (model) =>
        route?.generationDefaultsForModel?.(model) ??
        (model === routeModel ? route?.generationDefaults : undefined),
      unavailable,
    },
    {
      requestId: id,
      logger,
      signal: req.signal,
      // upstreamFetch, never bare globalThis.fetch: Bun's default 300 s idle
      // timeout would end a silent `max`-effort reasoning stretch with
      // `TimeoutError: The operation timed out.` (see upstream-fetch.ts).
      fetchImpl: fetchImpl ?? upstreamFetch,
      resolveCandidates: (model) => hooks.resolveUpstream(routed.principal, model),
      notePoolRateLimit: hooks.notePoolRateLimit
        ? (secretId, seconds) => hooks.notePoolRateLimit!(routed.principal, secretId, seconds)
        : undefined,
      notePoolUsage: hooks.notePoolUsage
        ? (secretId, usage) => hooks.notePoolUsage!(routed.principal, secretId, usage)
        : undefined,
      refreshCredential: hooks.refreshCredential
        ? (descriptor) => hooks.refreshCredential!(routed.principal, descriptor)
        : undefined,
      admitCharge: chargeAdmitted,
    },
  );
  // Dispatch owns the parsed request now; this frame drops it before the
  // provider wait.
  body = null;
  const outcome = await pending;
  emit.mark('upstream_response');
  if (outcome.response?.ok) holdAfterDispatch(outcome);
  return { outcome, streaming, promptTokenEstimate, cachedTokenEstimate, streamRedispatchBody };
}
