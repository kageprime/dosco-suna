import type {
  AuthedPrincipal,
  BillingMode,
  GatewayAttemptFailure,
  GatewayHooks,
  GatewayLogger,
  GatewayTrace,
  ModelRoutePlan,
  UpstreamDescriptor,
} from '../domain';
import type { FetchImpl } from '../http';
import { GatewayResolutionError } from '../errors';
import { upstreamFetch } from '../upstream-fetch';
import { calculateCost } from '../usage/pricing';
import { fallbackModelsOf } from './dispatch';
import {
  admissionUnavailable,
  admitOrRefuse,
  ensureBillingHold,
  MISSING_TOKEN,
  type Refusal,
  type RefusalSite,
  refusalResponse,
  refuse,
  stopped,
  traceRefusal,
} from './request-refusal';
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type ImageAttempt,
  type ImageFailure,
  type ImageInput,
  type ImageResult,
  MAX_IMAGE_RESPONSE_BYTES,
  imageAdapterFor,
} from './image-adapters';
import { shownModel, shownProvider } from './public-identity';
import { type HandlerRuntime, bearer, identity, requestId } from './simple-handler';
import { type TraceEmitter, type TraceFields, createTraceEmitter } from './trace';

export type ImageOperation = 'generations' | 'edits';

export interface ImageRequest {
  authorization: string | undefined;
  rawBody: string;
  operation: ImageOperation;
  signal?: AbortSignal;
  /** Test seam: the whole request's budget. Default 300 s. */
  timeoutMs?: number;
}

const MAX_REFERENCE_IMAGES = 5;
const UPSTREAM_TIMEOUT_MS = 300_000;
/** ChatGPT image-limit headers, relayed on success and on 429 so a client can show when the limit resets. */
const LIMIT_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-primary-reset-after-seconds',
  'x-codex-primary-window-minutes',
];
/** A Phase 1 kortixd sends `size`; it maps to the matching ratio during rollout. */
const ASPECT_FOR_SIZE = new Map<unknown, AspectRatio>([
  ['auto', 'auto'],
  ['1024x1024', '1:1'],
  ['1536x1024', '3:2'],
  ['1024x1536', '2:3'],
]);
const NO_IMAGE_MODEL_SUGGESTION = 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.';

/** The refusal that ends a request past its own time budget. */
const IMAGE_STOP = { code: 'image_timeout', message: 'Image generation timed out.' };

/**
 * The request in the gateway's own contract (U-D1). Unknown keys never reach
 * an upstream and `n` is always 1. Returns an error message for an invalid body.
 */
function imageInput(raw: string, operation: ImageOperation): { input: ImageInput; model: string } | string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return 'Invalid JSON body';
  }
  if (!parsed || typeof parsed !== 'object') return 'Invalid JSON body';
  if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return '`prompt` is required.';
  const input: ImageInput = { operation, prompt: parsed.prompt };
  if (parsed.aspect_ratio !== undefined) {
    if (!ASPECT_RATIOS.includes(parsed.aspect_ratio as AspectRatio)) {
      return `\`aspect_ratio\` must be one of ${ASPECT_RATIOS.join(', ')}.`;
    }
    input.aspectRatio = parsed.aspect_ratio as AspectRatio;
  } else if (ASPECT_FOR_SIZE.has(parsed.size)) {
    input.aspectRatio = ASPECT_FOR_SIZE.get(parsed.size);
  }
  if (typeof parsed.quality === 'string') input.quality = parsed.quality;
  if (typeof parsed.background === 'string') input.background = parsed.background;
  if (operation === 'edits') {
    const images = parsed.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_REFERENCE_IMAGES) {
      return `\`images\` needs 1 to ${MAX_REFERENCE_IMAGES} reference images.`;
    }
    const urls = images.map((image) => (image as { image_url?: unknown } | null)?.image_url);
    if (!urls.every((url): url is string => typeof url === 'string' && url.length > 0)) {
      return 'Every image needs an `image_url`.';
    }
    input.images = urls;
  }
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : 'auto';
  return { input, model };
}

function limitHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LIMIT_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Seconds until the image limit resets: `retry-after`, else the ChatGPT reset header, else 60. */
function restSeconds(upstream: Headers): number {
  for (const name of ['retry-after', 'x-codex-primary-reset-after-seconds']) {
    const seconds = Number.parseFloat(upstream.get(name) ?? '');
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return 60;
}

const SAFETY_REFUSAL = /moderation|content[_ ]policy|safety/i;

/**
 * What the client hears when `descriptor` answered without an image. A
 * managed model's upstream text never reaches the client (public identity).
 */
function refusalFor(failure: ImageFailure, descriptor: UpstreamDescriptor, model: string, provider: string): Refusal {
  const name = descriptor.provider === 'openai-codex' ? 'ChatGPT' : provider;
  if (failure.status === 429) {
    return {
      status: 429,
      code: 'image_rate_limited',
      message: `The ${name} image limit is reached.`,
      suggestion: 'Wait for the limit to reset, then retry.',
      retryAfter: restSeconds(failure.headers),
      headers: limitHeaders(failure.headers),
    };
  }
  if (failure.code === 'image_response_too_large') {
    return {
      status: 502,
      code: 'image_response_too_large',
      message: `${model} answered with more than ${MAX_IMAGE_RESPONSE_BYTES / 1024 / 1024} MiB.`,
      suggestion: 'Retry, or choose another image model.',
    };
  }
  if (failure.status === 401 && descriptor.publicProvider) {
    // A managed model's key is Kortix's own: there is nothing for the user to reconnect.
    return { status: 502, code: 'image_upstream_error', message: `${model} is unavailable right now.`, suggestion: 'Retry, or choose another image model.' };
  }
  if (failure.status === 401) {
    return descriptor.provider === 'openai-codex'
      ? { status: 401, code: 'provider_reauth_required', message: 'The ChatGPT login expired.', suggestion: 'Reconnect ChatGPT in Models, then retry.' }
      : { status: 401, code: 'provider_reauth_required', message: `${name} refused the credential.`, suggestion: `Check the ${name} key in project settings, then retry.` };
  }
  const message = descriptor.publicProvider ? '' : failure.message;
  const safety = failure.status < 500 && SAFETY_REFUSAL.test(`${failure.code ?? ''} ${message}`);
  return {
    status: failure.status >= 500 ? 502 : failure.status,
    code: 'image_upstream_error',
    message: failure.code === 'no_image' ? `${model} returned no image.` : message || `${name} answered ${failure.status}.`,
    suggestion: safety
      ? 'Change the prompt or the reference images, then retry.'
      : `Retry, or check the ${name} connection in project settings.`,
  };
}

/** The models to try, in order: the host's image plan, or the named model alone. */
function plannedModels(route: ModelRoutePlan | null, requestedModel: string): string[] {
  // A host without image routing answers an image request with a chat plan;
  // its models cannot generate images, so it counts as no plan.
  if (route?.policyId === 'image' && route.primaryModel) {
    return [route.primaryModel, ...fallbackModelsOf({ model: route.primaryModel, fallbackModels: route.fallbackModels })];
  }
  return requestedModel === 'auto' ? [] : [requestedModel];
}

/** One request's state, shared by its steps. */
interface Run {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  fetchImpl: FetchImpl;
  req: ImageRequest;
  id: string;
  emit: TraceEmitter;
  operation: string;
  principal: AuthedPrincipal;
  input: ImageInput;
  requestedModel: string;
  models: string[];
  /** The candidate tried last: what error bodies and traces name. */
  resolvedModel: string;
  provider: string;
  billingMode: BillingMode;
  attempts: number;
  candidatesTried: string[];
  attemptFailures: GatewayAttemptFailure[];
  refreshed: boolean;
  charge: Promise<Refusal | null> | null;
  clientSignal?: AbortSignal;
  signal: AbortSignal;
  last?: Refusal;
  trace(fields: TraceFields, extra?: Partial<GatewayTrace>): void;
  readonly site: RefusalSite;
}

function refusalSite(run: Run): RefusalSite {
  return { id: run.id, provider: run.provider, requestedModel: run.requestedModel, resolvedModel: run.resolvedModel };
}

function trace(run: Run, fields: { status: number; ok: boolean; errorCode?: string; errorMessage?: string }, extra = {}): void {
  traceRefusal(run.emit, run.principal, run.operation, {
    requestedModel: run.requestedModel,
    resolvedModel: run.resolvedModel,
    provider: run.provider,
    billingMode: run.billingMode,
    attempts: run.attempts,
    candidatesTried: run.candidatesTried,
    ...(run.attemptFailures.length ? { attemptFailures: run.attemptFailures } : {}),
  }, { ...fields, ...extra });
}

function failed(run: Run, model: string, refusal: Refusal, stage: GatewayAttemptFailure['stage'] = 'dispatch'): void {
  run.last = refusal;
  run.attemptFailures.push({
    attempt: run.attemptFailures.length + 1,
    provider: run.provider,
    routeModel: model,
    resolvedModel: run.resolvedModel,
    stage,
    status: refusal.status,
    code: refusal.code,
    message: refusal.message,
  });
}

/** Step 1, admission: the bearer token, the account, and a valid body. */
async function admit(runtime: HandlerRuntime, req: ImageRequest): Promise<Run | Response> {
  const { hooks, logger } = runtime;
  const id = requestId();
  const emit = createTraceEmitter(hooks, logger, id, new Date().toISOString(), Date.now());
  const operation = `images.${req.operation}`;
  const unnamed: RefusalSite = { id, provider: '', requestedModel: '', resolvedModel: '' };

  const admitted = await admitOrRefuse(runtime, bearer(req.authorization), { operation, site: unnamed, emit });
  if (admitted instanceof Response) return admitted;

  const timeoutMs = req.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const run: Run = {
    hooks,
    logger,
    fetchImpl: runtime.fetchImpl ?? upstreamFetch,
    req,
    id,
    emit,
    operation,
    principal: admitted.admission.principal,
    input: { operation: req.operation, prompt: '' },
    requestedModel: '',
    models: [],
    resolvedModel: '',
    provider: '',
    billingMode: 'none',
    attempts: 0,
    candidatesTried: [],
    attemptFailures: [],
    refreshed: false,
    charge: null,
    clientSignal: req.signal,
    signal: req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    trace(fields, extra) {
      return trace(this, fields, extra);
    },
    get site() {
      return refusalSite(this);
    },
  };
  const parsed = imageInput(req.rawBody, req.operation);
  req.rawBody = '';
  if (typeof parsed === 'string') {
    return refuse(run, { status: 400, code: 'invalid_request', message: parsed, suggestion: 'Fix the request body and retry.' });
  }
  run.input = parsed.input;
  run.requestedModel = parsed.model;
  return run;
}

/** Step 2, plan: the models to try, from the host's image route. */
async function plan(run: Run): Promise<Refusal | null> {
  let route: ModelRoutePlan | null;
  try {
    route = (await run.hooks.resolveRoute?.(run.principal, {
      requestedModel: run.requestedModel,
      requires: { imageInput: run.req.operation === 'edits', imageOutput: true },
    })) ?? null;
    run.emit.mark('routed');
  } catch (error) {
    if (error instanceof GatewayResolutionError) {
      return { status: 400, code: error.code, message: error.message, suggestion: error.suggestion };
    }
    run.logger.error(`[gateway] ${run.id}: image routing unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return { status: 502, code: 'routing_unavailable', message: 'Model routing is unavailable', suggestion: 'Retry the request.' };
  }
  run.models = plannedModels(route, run.requestedModel);
  if (run.models.length) return null;
  return {
    status: 400,
    code: 'image_model_unavailable',
    message: 'No image model is available for this project.',
    suggestion: NO_IMAGE_MODEL_SUGGESTION,
  };
}

/** Step 3, one model: its candidates in order. Null: the model failed (recorded in `run.last`). */
async function tryModel(run: Run, model: string): Promise<Response | null> {
  run.resolvedModel = model;
  // Before a descriptor exists, the routed model id names the provider (R37): a resolution
  // refusal says whose connection is missing. `codex/*` is ChatGPT, whose descriptor id is
  // `openai-codex`. The id is already public: `resolved_model` carries the same prefix.
  const prefix = model.split('/')[0]!;
  run.provider = model.includes('/') ? (prefix === 'codex' ? 'openai-codex' : prefix) : '';
  let candidates: UpstreamDescriptor[];
  try {
    candidates = await run.hooks.resolveUpstream(run.principal, model);
  } catch (error) {
    const resolution = error instanceof GatewayResolutionError ? error : null;
    failed(run, model, {
      status: resolution?.code === 'provider_pool_rate_limited' ? 429 : 400,
      code: resolution?.code ?? 'model_unavailable',
      message: resolution?.message ?? `No provider is configured for model "${model}"`,
      suggestion: resolution?.suggestion ?? 'Connect the provider or choose another model.',
      retryAfter: resolution?.retryAfterSeconds,
    }, 'resolve');
    return null;
  }
  if (!candidates.length) {
    failed(run, model, {
      status: 400,
      code: 'model_unavailable',
      message: `No provider is configured for model "${model}"`,
      suggestion: 'Connect the provider or choose another model.',
    }, 'resolve');
    return null;
  }
  // Pooled accounts of one model: only a 429 moves to the next one (R6).
  for (const descriptor of candidates) {
    const outcome = await tryCandidate(run, descriptor, model);
    if (outcome !== 'next-account') return outcome;
  }
  return null;
}

/** Step 4, one candidate: checks, the upstream call, one refresh on a 401. */
async function tryCandidate(run: Run, candidate: UpstreamDescriptor, model: string): Promise<Response | 'next-account' | null> {
  let descriptor = candidate;
  run.provider = shownProvider(descriptor);
  run.resolvedModel = shownModel(descriptor, model);
  run.billingMode = descriptor.billingMode;
  const adapter = imageAdapterFor(descriptor);
  if (!adapter) {
    failed(run, model, {
      status: 400,
      code: 'image_model_unsupported',
      message: `${model} cannot generate images through Kortix.`,
      suggestion: 'Choose an image model, or use auto.',
    });
    return null;
  }
  if (descriptor.billingMode !== 'none') {
    // Kortix never serves a managed image it cannot charge.
    if (!descriptor.pricing) {
      failed(run, model, {
        status: 400,
        code: 'image_model_unpriced',
        message: `${model} has no image price.`,
        suggestion: 'Choose another image model, or use auto.',
      });
      return null;
    }
    // One wallet admission per request: the hold is taken once, before the
    // first Kortix-billed candidate, exactly as chat takes it. A hold is
    // settled with the usage event or returned by `refuse`.
    const denied = await (run.charge ??= ensureBillingHold(run));
    if (denied) {
      failed(run, model, denied);
      return null;
    }
  }

  const send = (target: UpstreamDescriptor) => {
    run.attempts += 1;
    run.candidatesTried.push(`${run.provider}:${model}`);
    return adapter(target, run.input, { fetchImpl: run.fetchImpl, signal: run.signal, requestId: run.id });
  };
  let attempt: ImageAttempt;
  try {
    attempt = await send(descriptor);
    if (!attempt.ok && attempt.status === 401 && descriptor.refreshableCredential && run.hooks.refreshCredential && !run.refreshed) {
      run.refreshed = true;
      const fresh = await run.hooks.refreshCredential(run.principal, descriptor);
      if (fresh) {
        descriptor = fresh;
        attempt = await send(descriptor);
      }
    }
  } catch (error) {
    const stop = stopped(run, IMAGE_STOP);
    if (stop) return refuse(run, stop);
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} image upstream unreachable — ${error instanceof Error ? error.message : String(error)}`);
    failed(run, model, {
      status: 502,
      code: 'image_upstream_unreachable',
      message: `${descriptor.provider === 'openai-codex' ? 'ChatGPT' : run.provider} could not be reached.`,
      suggestion: 'Retry the request.',
    });
    return null;
  }
  run.emit.mark('upstream_response');
  if (attempt.ok) return settle(run, descriptor, model, attempt);

  // An abort while the answer was read leaves an unreadable 200.
  const stop = stopped(run, IMAGE_STOP);
  if (stop) return refuse(run, stop);
  // Server log only: the upstream's own text and identity.
  if (attempt.detail) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} image ${attempt.status} for ${descriptor.resolvedModel ?? model}: ${attempt.detail.slice(0, 300)}`);
  }
  failed(run, model, refusalFor(attempt, descriptor, model, run.provider));
  // The image quota is separate from chat, and the pool cooldown is keyed per
  // secret: noting it here would block chat on this login (R6). A 429 tries
  // the next pooled account within this request only.
  return attempt.status === 429 ? 'next-account' : null;
}

/**
 * Step 5, settle and respond: cost, one usage event, the trace, the normalized answer (U-D1).
 * Null: a billed image without a price failed (recorded in `run.last`).
 */
async function settle(run: Run, descriptor: UpstreamDescriptor, model: string, result: ImageResult): Promise<Response | null> {
  const counts = result.usage;
  const { upstreamCost, finalCost } = calculateCost(
    descriptor.resolvedModel ?? model,
    counts,
    descriptor.billingMode === 'none' ? 0 : descriptor.markup,
    result.upstreamCostUsd,
    descriptor.pricing,
  );
  // A billed image answered without usage or a cost is not free: it is not
  // delivered, and the hold settles with the next model or returns (CWE-840).
  if (descriptor.billingMode !== 'none' && !(finalCost > 0)) {
    failed(run, model, {
      status: 502,
      code: 'image_model_unpriced',
      message: `${model} answered without a billable image usage.`,
      suggestion: 'Retry, or choose another image model.',
    });
    return null;
  }
  const upstream = descriptor.publicProvider
    ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? model } }
    : {};
  const tokens = counts.promptTokens + counts.completionTokens;
  const body = JSON.stringify({
    created: result.created ?? Math.floor(Date.now() / 1000),
    model,
    provider: run.provider,
    data: [{ b64_json: result.b64, mime_type: result.mimeType }],
    ...(result.size ? { size: result.size } : {}),
    ...(tokens > 0
      ? { usage: { input_tokens: counts.promptTokens, output_tokens: counts.completionTokens, total_tokens: tokens } }
      : {}),
  });
  const headers = { 'content-type': 'application/json', ...limitHeaders(result.headers) };
  // The response body is now the only copy of the image.
  result.b64 = '';
  const { principal } = run;
  try {
    await run.hooks.recordUsage({
      ...counts,
      ...identity(principal),
      provider: run.provider,
      model: run.resolvedModel,
      ...upstream,
      upstreamCost,
      finalCost,
      billingMode: descriptor.billingMode,
      streaming: false,
      requestId: run.id,
      operation: `images.${run.req.operation}` as const,
      ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
    });
  } catch (error) {
    run.logger.error(`[gateway] ${run.id}: image usage was not recorded — ${error instanceof Error ? error.message : String(error)}`);
  }
  trace(run, { status: 200, ok: true }, {
    ...upstream,
    servedModel: model,
    ...(model !== run.models[0] ? { fallbackFrom: run.models[0] } : {}),
    usage: counts,
    upstreamCost,
    finalCost,
  });
  return new Response(body, { status: 200, headers });
}

export async function handleImageRequest(runtime: HandlerRuntime, req: ImageRequest): Promise<Response> {
  const run = await admit(runtime, req);
  if (run instanceof Response) return run;
  const unplanned = await plan(run);
  if (unplanned) return refuse(run, unplanned);
  run.emit.mark('dispatch');
  for (const model of run.models) {
    const answered = await tryModel(run, model);
    if (answered) return answered;
  }
  // Every planned model failed: the last failure is the answer.
  return refuse(run, run.last!);
}
