import type {
  GatewayAttemptFailure,
  ModelRoutePlan,
  UpstreamDescriptor,
} from '../domain';
import { GatewayResolutionError } from '../errors';
import {
  fallbackCandidates,
  fallbackModelsOf,
  fallbackTakesOver,
} from './dispatch';
import { gatewayErrorResponse } from './error-response';
import {
  shownModel,
  shownProvider,
} from './public-identity';
import {
  MAX_HOLD_SECONDS,
  SETUP_HOLD_SECONDS,
  routeMemoryKey,
} from './route-memory';

import type { admitChat } from './admission';
import type { HandlerRuntime } from './chat-shared';
import { CHAIN_TAKES_OVER, billingRefusal, identity, refundHold } from './chat-shared';
type Admission = Exclude<Awaited<ReturnType<typeof admitChat>>, Response>;
export async function routeChat(runtime: HandlerRuntime, admission: Omit<Admission, 'body'>) {
  const { hooks, logger } = runtime;
  const { id, emit, prefetched, requestedModel, routeInput } = admission;
  let { principal, routedModel } = admission;
  // One wallet admission per request: before dispatch when the routed model is
  // Kortix-billed, or before the first Kortix-billed fallback of a failed own
  // key or ChatGPT request. A hold it takes is settled or refunded as usual.
  let chargeAdmission: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
  const admitCharge = () => {
    chargeAdmission ??= (async () => {
      if (principal.billingHold) return { ok: true as const };
      const answered = prefetched?.billing;
      if (answered instanceof Error) return { ok: false as const, error: answered };
      try {
        const billing = answered ?? await hooks.assertBillingActive(principal.accountId);
        if (billing?.holdUsd) principal = { ...principal, billingHold: { amountUsd: billing.holdUsd } };
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    return chargeAdmission;
  };
  const chargeAdmitted = async () => (await admitCharge()).ok;

  let route: ModelRoutePlan | null;
  try {
    route = prefetched?.route !== undefined
      ? prefetched.route
      : (await hooks.resolveRoute?.(principal, routeInput)) ?? null;
    routedModel = route?.primaryModel || requestedModel;
    emit.mark('routed');
  } catch (error) {
    refundHold(hooks, principal, logger);
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: routedModel,
      status: 502,
      ok: false,
      errorCode: 'routing_unavailable',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return gatewayErrorResponse(502, {
      message: 'Model routing is unavailable',
      code: 'routing_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: 'Retry the request.',
    });
  }

  // The model the route named. A rescued request starts at one of its fallbacks.
  const routeModel = routedModel;
  // `project:*` routes come from the project's own Routing settings.
  const fallbackChosenByProject = route?.policyId.startsWith('project:') ?? false;
  const { routeMemory } = runtime;
  const memoryKey = routeMemoryKey(principal, routeModel);
  /**
   * Starts the project's own chain when the routed model has no usable
   * upstream: every own key or ChatGPT account is paused or needs reconnection
   * (see CHAIN_TAKES_OVER). The routed model is an own key or ChatGPT plan, so
   * a Kortix-billed fallback needs the wallet admission first.
   */
  const startChainWithout = async (resolution: GatewayResolutionError) => {
    const status = CHAIN_TAKES_OVER[resolution.code];
    if (!status || !route?.policyId.startsWith('project:')) return null;
    if (!fallbackTakesOver(route.fallbackOn ?? 'transient', { status })) return null;
    const models = fallbackModelsOf({ model: routeModel, fallbackModels: route.fallbackModels });
    for (const [index, model] of models.entries()) {
      const candidates = await fallbackCandidates(model, {
        byok: true,
        chosenByProject: true,
        resolveCandidates: (next) => hooks.resolveUpstream(principal, next),
        admitCharge: chargeAdmitted,
        logger,
        requestId: id,
      });
      if (!candidates.length) continue;
      logger.warn(`[gateway] ${id}: ${routeModel} is unavailable (${resolution.code}); the project's chain starts at ${model}`);
      const resting = resolution.code === 'provider_pool_rate_limited';
      const holdSeconds = Math.min(resting ? (resolution.restSeconds ?? resolution.retryAfterSeconds ?? MAX_HOLD_SECONDS) : SETUP_HOLD_SECONDS, MAX_HOLD_SECONDS);
      const failure: GatewayAttemptFailure = {
        attempt: 1,
        provider: routeModel.split('/')[0] || routeModel,
        routeModel,
        resolvedModel: routeModel,
        stage: 'resolve',
        status,
        code: resolution.code,
        message: resolution.message,
        holdSeconds,
      };
      routeMemory?.hold(memoryKey, { fallbackModel: model, failure, byok: true }, holdSeconds);
      return { model, candidates, remaining: models.slice(index + 1), unavailable: { model: routeModel, failure } };
    }
    return null;
  };

  /**
   * Starts at the fallback that answered this caller's last request while the
   * routed model is held. The routed model stays last in the chain, so a
   * request whose fallbacks all fail still tries it.
   */
  const startHeldChain = async () => {
    const held = routeMemory?.recall(memoryKey);
    if (!held || !route) return null;
    const models = fallbackModelsOf({ model: routeModel, fallbackModels: route.fallbackModels });
    const index = models.indexOf(held.fallbackModel);
    const candidates = index < 0 ? [] : await fallbackCandidates(held.fallbackModel, {
      byok: held.byok,
      chosenByProject: fallbackChosenByProject,
      resolveCandidates: (next) => hooks.resolveUpstream(principal, next),
      admitCharge: chargeAdmitted,
      logger,
      requestId: id,
    });
    if (!candidates.length) {
      routeMemory?.release(memoryKey);
      return null;
    }
    return {
      model: held.fallbackModel,
      candidates,
      remaining: [...models.slice(index + 1), routeModel],
      unavailable: { model: routeModel, failure: { ...held.failure, stage: 'held' as const } },
    };
  };

  let descriptor: UpstreamDescriptor | undefined;
  let resolvedCandidates: UpstreamDescriptor[] = [];
  let chain = route?.fallbackModels;
  let unavailable: { model: string; failure: GatewayAttemptFailure } | undefined;
  const held = await startHeldChain();
  if (held) {
    resolvedCandidates = held.candidates;
    descriptor = held.candidates[0];
    routedModel = held.model;
    chain = held.remaining;
    unavailable = held.unavailable;
    emit.mark('resolved');
  } else try {
    const answered = prefetched?.upstream;
    if (answered instanceof Error) throw answered;
    resolvedCandidates = answered ?? await hooks.resolveUpstream(principal, routedModel);
    descriptor = resolvedCandidates[0];
    emit.mark('resolved');
  } catch (error) {
    const resolution = error instanceof GatewayResolutionError ? error : null;
    const started = resolution ? await startChainWithout(resolution) : null;
    if (!started) {
      refundHold(hooks, principal, logger);
      const status = resolution?.code === 'provider_pool_rate_limited' ? 429 : 400;
      // The refusal the client sees is also the request's log row: a plan,
      // provider or model refusal is invisible in usage and logs without it
      // (KRTX-1749).
      emit({
        ...identity(principal),
        requestedModel,
        resolvedModel: routedModel,
        status,
        ok: false,
        errorCode: resolution?.code ?? 'model_unavailable',
        errorMessage: resolution?.message ?? `No provider is configured for model "${routedModel}"`,
      });
      return gatewayErrorResponse(status, {
        message: resolution?.message ?? `No provider is configured for model "${routedModel}"`,
        code: resolution?.code ?? 'model_unavailable',
        provider: '',
        requestedModel,
        resolvedModel: routedModel,
        requestId: id,
        suggestion: resolution?.suggestion ?? 'Connect the provider or choose another model.',
        retryAfterSeconds: resolution?.retryAfterSeconds,
      });
    }
    resolvedCandidates = started.candidates;
    descriptor = started.candidates[0];
    routedModel = started.model;
    chain = started.remaining;
    unavailable = started.unavailable;
    emit.mark('resolved');
  }
  if (!descriptor) {
    refundHold(hooks, principal, logger);
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: routedModel,
      status: 400,
      ok: false,
      errorCode: 'model_unavailable',
      errorMessage: `No provider is configured for model "${routedModel}"`,
    });
    return gatewayErrorResponse(400, {
      message: `No provider is configured for model "${routedModel}"`,
      code: 'model_unavailable',
      provider: '',
      requestedModel,
      resolvedModel: routedModel,
      requestId: id,
      suggestion: 'Connect the provider or choose another model.',
    });
  }

  // Resolve the payee before touching the wallet. BYOK descriptors use the
  // customer's provider account and must never create a Kortix hold or debit.
  if (descriptor.billingMode !== 'none') {
    const admitted = await admitCharge();
    if (!admitted.ok) {
      const { error } = admitted;
      const refusal = billingRefusal(error);
      const detail = error instanceof Error ? error.message : String(error);
      if (refusal.status === 503) logger.error(`[gateway] ${id}: billing check unavailable — ${detail}`);
      emit({
        ...identity(principal),
        requestedModel,
        resolvedModel: shownModel(descriptor, routedModel),
        provider: shownProvider(descriptor),
        status: refusal.status,
        ok: false,
        errorCode: refusal.code,
        errorMessage: error instanceof Error ? error.message : refusal.message,
      });
      return gatewayErrorResponse(refusal.status, {
        message: refusal.message,
        code: refusal.code,
        provider: shownProvider(descriptor),
        requestedModel,
        resolvedModel: shownModel(descriptor, routedModel),
        requestId: id,
        suggestion: refusal.suggestion,
        ...(refusal.retryAfter !== undefined ? { retryAfterSeconds: refusal.retryAfter } : {}),
      });
    }
    emit.mark('billed');
  }

  return { get principal() { return principal; }, route, routedModel, routeModel, fallbackChosenByProject, memoryKey, descriptor, resolvedCandidates, chain, unavailable, chargeAdmitted };
}
