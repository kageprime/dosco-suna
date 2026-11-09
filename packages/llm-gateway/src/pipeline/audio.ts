import type {
  AdmitResult,
  AuthedPrincipal,
  GatewayHooks,
  GatewayLogger,
  TokenCounts,
  UpstreamDescriptor,
} from '../domain';
import { GatewayResolutionError } from '../errors';
import type { FetchImpl } from '../http';
import { upstreamHeaders } from '../http/call-upstream';
import { trimTrailingSlash } from '../transports/ai-sdk/model';
import { upstreamFetch } from '../upstream-fetch';
import { calculateCost } from '../usage/pricing';
import { clampRetryAfterSeconds } from './error-response';
import { shownModel, shownProvider } from './public-identity';
import {
  admissionUnavailable,
  admitOrRefuse,
  ensureBillingHold,
  MISSING_TOKEN,
  type Refusal,
  type RefusalSite,
  type RefusalWire,
  audioRefusalResponse,
  refuse,
  stopped,
  traceRefusal,
} from './request-refusal';
import { type HandlerRuntime, bearer, identity, requestId } from './simple-handler';
import { type TraceEmitter, type TraceFields, createTraceEmitter } from './trace';

export type AudioOperation = 'transcriptions' | 'speech';

export interface AudioRequest {
  authorization: string | undefined;
  operation: AudioOperation;
  /** multipart/form-data for transcriptions, JSON for speech. */
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  signal?: AbortSignal;
  /** Test seam: the whole request's budget. Default `AUDIO_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface VoicesRequest {
  authorization: string | undefined;
  /** The speech model whose voices to list: it selects the upstream. */
  model: string;
  signal?: AbortSignal;
}

/** Platinum ends every audio request at 60 s; this bounds only a connection that hangs. */
const AUDIO_TIMEOUT_MS = 120_000;
/** The upstream's price for one speech request, in USD. Never relayed. */
const SPEECH_COST_HEADER = 'x-platinum-cost';
const TRANSCRIPTION_FORMATS = ['json', 'verbose_json', 'text'] as const;
type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number];
/** Forwarded besides `file`, `model` and `response_format`; every other field is dropped. */
const TRANSCRIPTION_FIELDS = ['language', 'prompt', 'temperature'];
const SPEECH_FORMATS = ['pcm', 'mp3'];
const NO_TOKENS: TokenCounts = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
const WHAT: Record<AudioOperation, string> = { transcriptions: 'transcription', speech: 'speech' };

type Input =
  | { operation: 'transcriptions'; form: FormData; format: TranscriptionFormat }
  | { operation: 'speech'; body: Record<string, unknown> };

/** `model` is read before every other field, so admission can resolve it while another field is wrong. */
type Parsed = { model: string; input: Input } | { model: string; error: string };

/** The refusal that ends a request past its own time budget. */
const AUDIO_STOP = { code: 'audio_timeout', message: 'The audio request timed out.' };

/** One request's state, shared by its steps. */
interface Run {
  hooks: GatewayHooks;
  logger: GatewayLogger;
  fetchImpl: FetchImpl;
  id: string;
  emit: TraceEmitter;
  operation: AudioOperation;
  principal: AuthedPrincipal;
  model: string;
  descriptor?: UpstreamDescriptor;
  clientSignal?: AbortSignal;
  signal: AbortSignal;
  trace(fields: TraceFields): void;
  readonly site: RefusalSite;
  /** Audio's own refusal wire, for `refuse`: `retry-after` in the header alone, never a body field. */
  readonly wire?: RefusalWire;
}

type Named = Pick<Run, 'id' | 'model'> & { descriptor?: UpstreamDescriptor };

const present = (value: unknown) => value !== undefined && value !== null;

async function transcriptionInput(req: AudioRequest): Promise<Parsed> {
  let form: FormData;
  try {
    if (!/^multipart\/form-data\b/i.test(req.contentType)) throw new Error('not multipart');
    form = await new Response(req.body, { headers: { 'content-type': req.contentType } }).formData();
  } catch {
    return { model: '', error: 'Send a multipart/form-data body with `file` and `model`.' };
  }
  const model = form.get('model');
  if (typeof model !== 'string' || !model) return { model: '', error: '`model` is required.' };
  const file = form.get('file');
  if (!(file instanceof Blob)) return { model, error: '`file` is required.' };
  const format = form.get('response_format') ?? 'json';
  if (!TRANSCRIPTION_FORMATS.includes(format as TranscriptionFormat)) {
    return { model, error: '`response_format` must be json, verbose_json or text.' };
  }
  const out = new FormData();
  out.append('file', file);
  for (const field of TRANSCRIPTION_FIELDS) {
    const value = form.get(field);
    if (typeof value === 'string') out.append(field, value);
  }
  // A text answer carries no usage, so it cannot be billed: the upstream
  // answers json, and the gateway returns its text.
  out.append('response_format', format === 'text' ? 'json' : (format as string));
  return { model, input: { operation: 'transcriptions', form: out, format: format as TranscriptionFormat } };
}

function speechInput(req: AudioRequest): Parsed {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(req.body));
  } catch {
    // answered below
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { model: '', error: 'Invalid JSON body' };
  const { model, input, voice, response_format: format, sample_rate: rate, speed } = parsed as Record<string, unknown>;
  if (typeof model !== 'string' || !model) return { model: '', error: '`model` is required.' };
  if (typeof input !== 'string' || !input.trim()) return { model, error: '`input` is required.' };
  if (typeof voice !== 'string' || !voice.trim()) return { model, error: '`voice` is required.' };
  if (present(format) && !SPEECH_FORMATS.includes(format as string)) {
    return { model, error: '`response_format` must be pcm or mp3.' };
  }
  if (present(rate) && !(Number.isInteger(rate) && (rate as number) >= 8_000 && (rate as number) <= 48_000)) {
    return { model, error: '`sample_rate` must be an integer from 8000 to 48000.' };
  }
  if (present(speed) && !(typeof speed === 'number' && speed >= 0.5 && speed <= 1.5)) {
    return { model, error: '`speed` must be from 0.5 to 1.5.' };
  }
  const body: Record<string, unknown> = { input, voice };
  if (present(format)) body.response_format = format;
  if (present(rate)) body.sample_rate = rate;
  if (present(speed)) body.speed = speed;
  return { model, input: { operation: 'speech', body } };
}

/**
 * Only Kortix's managed upstream (Platinum Inference) serves audio: each of
 * its answers states the price the request is billed at.
 */
function servesAudio(descriptor: UpstreamDescriptor): boolean {
  return descriptor.provider === 'platinum' && descriptor.billingMode === 'credits';
}

function trace(run: Run, fields: TraceFields): void {
  const { descriptor } = run;
  traceRefusal(run.emit, run.principal, `audio.${run.operation}`, {
    requestedModel: run.model,
    resolvedModel: run.model,
    provider: descriptor ? shownProvider(descriptor) : '',
    billingMode: descriptor?.billingMode ?? 'none',
    streaming: run.operation === 'speech',
    attempts: descriptor ? 1 : 0,
    candidatesTried: descriptor ? [`${shownProvider(descriptor)}:${run.model}`] : [],
    ...(descriptor?.publicProvider
      ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? run.model } }
      : {}),
  }, fields);
}

function unreachable(at: Named): Refusal {
  return { status: 503, code: 'model_unavailable', message: `${at.model} is temporarily unavailable.`, suggestion: 'Retry in a few seconds.' };
}

function upstreamError(message: string): Refusal {
  return { status: 502, code: 'audio_upstream_error', message, suggestion: 'Retry the request.' };
}

/**
 * What the client hears when the upstream refused. A managed model's upstream
 * text never reaches the client (public identity): it goes to the server log.
 */
async function upstreamRefusal(at: Named & { logger: GatewayLogger; operation: AudioOperation }, response: Response): Promise<Refusal> {
  const detail = await response.text().catch(() => '');
  at.logger.warn(`[gateway] ${at.id}: ${at.descriptor?.provider} audio ${response.status} for ${at.model}: ${detail.slice(0, 300)}`);
  const { status } = response;
  if (status === 429) {
    return {
      status: 429,
      code: 'model_busy',
      message: `${at.model} is at capacity right now.`,
      suggestion: 'Retry in a few seconds.',
      retryAfter: clampRetryAfterSeconds(response.headers.get('retry-after')),
    };
  }
  // A model the upstream does not serve for this operation: a speech model
  // asked to transcribe, or a chat model.
  if (status === 404) {
    return {
      status: 400,
      code: 'model_not_found',
      message: `Kortix does not serve ${at.model} for ${WHAT[at.operation]}.`,
      suggestion: 'Choose a Kortix audio model.',
    };
  }
  // 401, 402 and 403 refuse Kortix's own key: nothing the client can change.
  if (status >= 400 && status < 500 && ![401, 402, 403].includes(status)) {
    return { status: 400, code: 'invalid_request', message: `${at.model} rejected this request.`, suggestion: 'Check the request fields, then retry.' };
  }
  return unreachable(at);
}

/** The model's upstream, from the admit answer or `resolveUpstream`. */
async function resolve(run: Run, prefetched: AdmitResult | null): Promise<UpstreamDescriptor | Refusal> {
  let candidates: UpstreamDescriptor[];
  try {
    const answered = prefetched?.upstream;
    if (answered instanceof Error) throw answered;
    candidates = answered ?? (await run.hooks.resolveUpstream(run.principal, run.model));
  } catch (error) {
    if (error instanceof GatewayResolutionError) {
      return { status: 400, code: error.code, message: error.message, suggestion: error.suggestion };
    }
    run.logger.error(`[gateway] ${run.id}: audio resolution unavailable — ${error instanceof Error ? error.message : String(error)}`);
    return { status: 502, code: 'routing_unavailable', message: 'Model routing is unavailable', suggestion: 'Retry the request.' };
  }
  run.emit.mark('resolved');
  const descriptor = candidates[0];
  if (!descriptor || !servesAudio(descriptor)) {
    return {
      status: 400,
      code: 'audio_model_unsupported',
      message: `Kortix does not serve ${run.model} for ${WHAT[run.operation]}.`,
      suggestion: 'Choose a Kortix audio model.',
    };
  }
  return descriptor;
}

/** The upstream's reported price (USD) with the managed markup, or null when it reported none. */
function priced(run: Run, reported: unknown): { upstreamCost: number; finalCost: number } | null {
  const descriptor = run.descriptor!;
  const cost = typeof reported === 'number' ? reported : typeof reported === 'string' && reported.trim() ? Number(reported) : Number.NaN;
  const breakdown = calculateCost(
    descriptor.resolvedModel ?? run.model,
    NO_TOKENS,
    descriptor.markup,
    Number.isFinite(cost) && cost >= 0 ? cost : undefined,
  );
  return breakdown.finalCost > 0 ? breakdown : null;
}

/** A Kortix-billed answer without a price is not served for free (CWE-840): it is not delivered. */
function unpriced(run: Run): Refusal {
  run.logger.error(`[gateway] ${run.id}: ${run.descriptor?.provider} audio answered ${run.model} without a price`);
  return { status: 502, code: 'audio_model_unpriced', message: `${run.model} answered without a price.`, suggestion: 'Retry the request.' };
}

async function recordUsage(run: Run, cost: { upstreamCost: number; finalCost: number }): Promise<void> {
  const descriptor = run.descriptor!;
  const { principal } = run;
  try {
    await run.hooks.recordUsage({
      ...NO_TOKENS,
      ...identity(principal),
      provider: shownProvider(descriptor),
      model: shownModel(descriptor, run.model),
      ...(descriptor.publicProvider
        ? { upstream: { provider: descriptor.provider, model: descriptor.resolvedModel ?? run.model } }
        : {}),
      ...cost,
      billingMode: descriptor.billingMode,
      streaming: run.operation === 'speech',
      requestId: run.id,
      operation: `audio.${run.operation}`,
      ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
    });
  } catch (error) {
    run.logger.error(`[gateway] ${run.id}: audio usage was not recorded — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Speech-to-text: one upstream call, billed from the answer's `usage.cost`. */
async function transcribe(run: Run, input: Extract<Input, { operation: 'transcriptions' }>): Promise<Response> {
  const descriptor = run.descriptor!;
  input.form.set('model', descriptor.resolvedModel ?? run.model);
  const headers = upstreamHeaders(descriptor, run.id);
  // fetch writes the multipart content type, with its boundary.
  delete headers['content-type'];
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: input.form,
      signal: run.signal,
    });
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} audio unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run, AUDIO_STOP) ?? unreachable(run));
  }
  run.emit.mark('upstream_response');
  if (!response.ok) return refuse(run, await upstreamRefusal(run, response));
  let answer: Record<string, unknown> | null = null;
  try {
    answer = (await response.json()) as Record<string, unknown>;
  } catch {
    // answered below
  }
  if (!answer || typeof answer !== 'object') {
    return refuse(run, stopped(run, AUDIO_STOP) ?? upstreamError(`${run.model} returned an unreadable answer.`));
  }
  const { usage, ...transcript } = answer as { usage?: { seconds?: unknown; cost?: unknown }; text?: unknown };
  const cost = priced(run, usage?.cost);
  if (!cost) return refuse(run, unpriced(run));
  // The client gets the billed duration; the upstream's price stays internal.
  const duration = typeof usage?.seconds === 'number' ? { usage: { type: 'duration', seconds: usage.seconds } } : {};
  const body = input.format === 'text' ? String(transcript.text ?? '') : JSON.stringify({ ...transcript, ...duration });
  await recordUsage(run, cost);
  trace(run, { status: 200, ok: true, servedModel: run.model, ...cost });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': input.format === 'text' ? 'text/plain; charset=utf-8' : 'application/json' },
  });
}

/**
 * Text-to-speech: the audio is relayed chunk by chunk as it arrives. The
 * gateway answers once the first chunk is in hand, so an upstream that fails
 * before any audio is still a typed error and not an empty 200. The upstream
 * bills from its first audio (`x-platinum-cost`), so the usage settles then,
 * off the audio's path, and the trace when the stream ends.
 */
async function speak(run: Run, input: Extract<Input, { operation: 'speech' }>): Promise<Response> {
  const descriptor = run.descriptor!;
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(descriptor.baseUrl)}/audio/speech`, {
      method: 'POST',
      headers: upstreamHeaders(descriptor, run.id),
      body: JSON.stringify({ model: descriptor.resolvedModel ?? run.model, ...input.body }),
      signal: run.signal,
    });
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} audio unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run, AUDIO_STOP) ?? unreachable(run));
  }
  run.emit.mark('upstream_response');
  if (!response.ok || !response.body) return refuse(run, await upstreamRefusal(run, response));
  const cost = priced(run, response.headers.get(SPEECH_COST_HEADER));
  if (!cost) {
    void response.body.cancel().catch(() => {});
    return refuse(run, unpriced(run));
  }
  const reader = response.body.getReader();
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    do first = await reader.read();
    while (!first.done && first.value.byteLength === 0);
  } catch (error) {
    run.logger.warn(`[gateway] ${run.id}: ${descriptor.provider} speech failed before audio — ${error instanceof Error ? error.message : String(error)}`);
    return refuse(run, stopped(run, AUDIO_STOP) ?? upstreamError(`${run.model} stopped before any audio.`));
  }
  if (first.done) return refuse(run, upstreamError(`${run.model} returned no audio.`));
  void recordUsage(run, cost);
  let ended = false;
  const end = (fields: TraceFields) => {
    if (ended) return;
    ended = true;
    trace(run, { servedModel: run.model, ...cost, ...fields });
  };
  const chunk = first.value;
  const audio = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          end({ status: 200, ok: true });
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        const stop = stopped(run, AUDIO_STOP);
        end({
          status: stop?.status ?? 502,
          ok: false,
          errorCode: stop?.code ?? 'audio_stream_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      end({ status: 499, ok: false, errorCode: 'client_aborted', errorMessage: 'The client cancelled the stream.' });
      await reader.cancel(reason).catch(() => {});
    },
  });
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
  const sampleRate = response.headers.get('x-sample-rate');
  if (sampleRate) headers.set('x-sample-rate', sampleRate);
  return new Response(audio, { status: 200, headers });
}

/** `POST /audio/transcriptions` and `POST /audio/speech`, OpenAI-shaped, on Kortix's managed audio models. */
export async function handleAudioRequest(runtime: HandlerRuntime, req: AudioRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const admitHook = hooks.admit;
  const id = requestId();
  const emit = createTraceEmitter(hooks, logger, id, new Date().toISOString(), Date.now());
  const token = bearer(req.authorization);
  if (!token) {
    return audioRefusalResponse({ id, provider: '', requestedModel: '', resolvedModel: '' }, MISSING_TOKEN);
  }
  const parsed = req.operation === 'transcriptions' ? await transcriptionInput(req) : speechInput(req);
  req.body = new Uint8Array(0);
  const admitted = await admitOrRefuse(runtime, token, {
    operation: `audio.${req.operation}`,
    site: { id, provider: '', requestedModel: parsed.model, resolvedModel: parsed.model },
    emit,
    requestedModel: parsed.model,
    prefetch: admitHook && 'input' in parsed
      ? (t) => admitHook(t, { requestedModel: parsed.model, requires: { imageInput: false } })
      : undefined,
    wire: audioRefusalResponse,
  });
  if (admitted instanceof Response) return admitted;
  const { admission, prefetched } = admitted;
  // The admit call already took this hold in the API: every exit below settles or refunds it.
  const hold = prefetched?.billing instanceof Error ? undefined : prefetched?.billing?.holdUsd;
  const timeout = AbortSignal.timeout(req.timeoutMs ?? AUDIO_TIMEOUT_MS);
  const run: Run = {
    hooks,
    logger,
    fetchImpl: runtime.fetchImpl ?? upstreamFetch,
    id,
    emit,
    operation: req.operation,
    principal: hold ? { ...admission.principal, billingHold: { amountUsd: hold } } : admission.principal,
    model: parsed.model,
    clientSignal: req.signal,
    signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
    trace(fields) {
      return trace(this, fields);
    },
    wire: audioRefusalResponse,
    get site() {
      return { id: this.id, provider: this.descriptor ? shownProvider(this.descriptor) : '', requestedModel: this.model, resolvedModel: this.model };
    },
  };
  emit.mark('admitted');
  if ('error' in parsed) {
    return refuse(run, { status: 400, code: 'invalid_request', message: parsed.error, suggestion: 'Fix the request body and retry.' });
  }
  const resolved = await resolve(run, prefetched);
  if (!('baseUrl' in resolved)) return refuse(run, resolved);
  run.descriptor = resolved;
  // The admit call already took this hold in the API: only a fresh billing
  // check is a billing step worth its trace split.
  const freshBilling = !run.principal.billingHold;
  const denied = await ensureBillingHold(run, prefetched);
  if (denied) return refuse(run, denied);
  if (freshBilling) run.emit.mark('billed');
  emit.mark('dispatch');
  return parsed.input.operation === 'transcriptions' ? transcribe(run, parsed.input) : speak(run, parsed.input);
}

/** `GET /audio/voices?model=`: the voices a speech model takes. Not billed, not traced, like the model list. */
export async function handleVoicesRequest(runtime: HandlerRuntime, req: VoicesRequest): Promise<Response> {
  const { hooks, logger } = runtime;
  const id = requestId();
  const site: RefusalSite = { id, provider: '', requestedModel: req.model, resolvedModel: req.model };
  const token = bearer(req.authorization);
  if (!token) {
    return audioRefusalResponse(site, MISSING_TOKEN);
  }
  let principal: AuthedPrincipal | null;
  try {
    principal = await hooks.authenticate(token);
  } catch (error) {
    return admissionUnavailable(site, logger, error, audioRefusalResponse);
  }
  if (!principal) {
    return audioRefusalResponse(site, { status: 401, code: 'invalid_token', message: 'Invalid token', suggestion: 'Sign in again or provide a valid API token, then retry.' });
  }
  if (!req.model) {
    return audioRefusalResponse(site, { status: 400, code: 'invalid_request', message: '`model` is required: the speech model whose voices to list.', suggestion: 'Add `?model=` and retry.' });
  }
  const timeout = AbortSignal.timeout(AUDIO_TIMEOUT_MS);
  const run: Run = {
    hooks,
    logger,
    fetchImpl: runtime.fetchImpl ?? upstreamFetch,
    id,
    emit: createTraceEmitter(hooks, logger, id, new Date().toISOString(), Date.now()),
    operation: 'speech',
    principal,
    model: req.model,
    clientSignal: req.signal,
    signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
    trace(fields) {
      return trace(this, fields);
    },
    get site() {
      return { id: this.id, provider: this.descriptor ? shownProvider(this.descriptor) : '', requestedModel: this.model, resolvedModel: this.model };
    },
  };
  const resolved = await resolve(run, null);
  if (!('baseUrl' in resolved)) return audioRefusalResponse(run.site, resolved);
  run.descriptor = resolved;
  const headers = upstreamHeaders(resolved, id);
  delete headers['content-type'];
  let response: Response;
  try {
    response = await run.fetchImpl(`${trimTrailingSlash(resolved.baseUrl)}/audio/voices`, { method: 'GET', headers, signal: run.signal });
  } catch (error) {
    logger.warn(`[gateway] ${id}: ${resolved.provider} voices unreachable — ${error instanceof Error ? error.message : String(error)}`);
    return audioRefusalResponse(run.site, stopped(run, AUDIO_STOP) ?? unreachable(run));
  }
  if (!response.ok) return audioRefusalResponse(run.site, await upstreamRefusal(run, response));
  const answer = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(answer?.data)) return audioRefusalResponse(run.site, upstreamError(`${run.model} returned an unreadable voice list.`));
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  // Only the documented fields reach the client.
  const data = (answer.data as Record<string, unknown>[])
    .filter((voice) => typeof voice?.id === 'string')
    .map((voice) => ({
      id: voice.id,
      name: typeof voice.name === 'string' ? voice.name : voice.id,
      description: typeof voice.description === 'string' ? voice.description : '',
      languages: strings(voice.languages),
      tags: strings(voice.tags),
    }));
  return new Response(JSON.stringify({ object: 'list', data }), { status: 200, headers: { 'content-type': 'application/json' } });
}
