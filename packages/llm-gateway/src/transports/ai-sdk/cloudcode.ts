/**
 * Google Antigravity via the Cloud Code wire protocol (`kind: 'google-cloudcode'`).
 *
 * Antigravity models run through Google's internal Cloud Code endpoint with the
 * user's own Google subscription (AI Pro / Ultra) OAuth credential. The wire
 * protocol is Gemini `generateContent`, wrapped in a Cloud Code envelope and
 * served from a different host:
 *
 *   POST {baseUrl}/v1internal:generateContent
 *   POST {baseUrl}/v1internal:streamGenerateContent?alt=sse
 *
 * Envelope (verified live 2026-11-12 against daily-cloudcode-pa.googleapis.com):
 *   { project, model, userAgent: 'antigravity', requestId,
 *     request: { contents, systemInstruction?, tools?, generationConfig? } }
 * Response: { response: { candidates, usageMetadata, modelVersion }, traceId }
 * Streaming: SSE `data: {response: {...}}` frames, incremental part deltas,
 * NO `[DONE]` marker — the stream ends when the connection closes. Each frame
 * may carry a `finishReason`; usageMetadata is cumulative across frames.
 *
 * Fingerprinting constraints (community-verified + live-confirmed):
 *  - Content calls carry ONLY `authorization`, `content-type` and
 *    `user-agent`. No extra headers (an `x-goog-api-key` or correlation
 *    header breaks the request), and the `user-agent` must be the Antigravity
 *    Hub client (`antigravity/hub/2.24.0 …`, version ≥ 2.23.0 required for
 *    the newer models).
 *  - Model ids are effort-suffixed: `gemini-3.8-flash-medium`,
 *    `claude-sonnet-5-5-high`, `gemini-4-argon-low`. A bare catalog id 404s
 *    ("Requested entity was not found."). The reasoning effort travels in the
 *    MODEL ID, not the body — `providerOptions.antigravity.reasoningEffort`
 *    (threaded by the cloudcode adapter in provider-options.ts) selects the
 *    variant.
 */

import type { LanguageModel } from 'ai';
import type { UpstreamDescriptor } from '../../domain';

/** The Antigravity Hub client user agent (the only fingerprint content calls may carry). */
export const ANTIGRAVITY_HUB_USER_AGENT =
  'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)';

/** The Cloud Code method paths, appended verbatim to the descriptor base URL. */
export const CLOUDCODE_HOST = 'https://daily-cloudcode-pa.googleapis.com';

type Json = Record<string, unknown>;
type JsonPart = { type: string; [key: string]: unknown };

// ── HTTP error carrier ──────────────────────────────────────────────────────
// Shaped like the AI SDK's own APICallError (`statusCode`/`responseBody`) so
// toTransportError (index.ts) maps it onto UpstreamHttpError with the RAW
// upstream body — the real `error.message` lives there — and the pipeline's
// 429 cooldown / 401 failover machinery sees the true status.
class CloudCodeHttpError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;
  readonly responseHeaders?: Record<string, string>;

  constructor(statusCode: number, responseBody: string, headers?: Record<string, string>) {
    super(`Cloud Code request failed with HTTP ${statusCode}`);
    this.name = 'APICallError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.responseHeaders = headers;
  }
}

// ── Structural AI SDK provider-v4 types ─────────────────────────────────────
// Deliberately local and loose (the same decoupling build-args.ts uses):
// `@ai-sdk/provider` is not a dependency of this package, and the runtime
// contract is enforced by generateText/streamText consuming these objects
// (the unit tests drive it end-to-end through the real `ai` package).

interface CloudCodePromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | JsonPart[];
}

interface CloudCodeCallOptions {
  prompt: CloudCodePromptMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: unknown; name?: string; description?: string };
  tools?: Array<JsonPart>;
  toolChoice?: JsonPart;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

interface CloudCodeUsage {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
  raw?: JSONObject;
}

type JSONObject = { [key: string]: unknown };

interface CloudCodeGenerateResult {
  content: JsonPart[];
  finishReason: { unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'; raw: string | undefined };
  usage: CloudCodeUsage;
  warnings: unknown[];
}

// ── Model id / effort mapping ───────────────────────────────────────────────

const EFFORT_SUFFIX_RE = /-(low|medium|high|tiered)$/;
const REQUESTED_EFFORTS = new Set(['low', 'medium', 'high']);

/** `gemini-3.8-flash-medium` → `gemini-3.8-flash` (also strips `-tiered`). */
export function stripEffortSuffix(modelId: string): string {
  return modelId.replace(EFFORT_SUFFIX_RE, '');
}

/**
 * Applies the request's reasoning effort as the model-id effort variant. The
 * Cloud Code protocol carries reasoning effort in the MODEL ID, so
 * `gemini-3.8-flash` + effort `low` → `gemini-3.8-flash-low`; an id that
 * already carries a variant gets it replaced. Ids without effort variants
 * (`gemini-2.5-flash`, `gpt-oss-120b-medium`) are only touched when the
 * client actually sent an effort — which the catalog's own effort gating
 * means happens exclusively for models that serve variants.
 */
export function applyEffortToModelId(resolvedModel: string, effort: unknown): string {
  if (typeof effort !== 'string' || !REQUESTED_EFFORTS.has(effort)) return resolvedModel;
  return `${stripEffortSuffix(resolvedModel)}-${effort}`;
}

function reasoningEffortFrom(options: CloudCodeCallOptions): string | undefined {
  const antigravity = options.providerOptions?.antigravity;
  const effort = (antigravity as Json | undefined)?.reasoningEffort;
  return typeof effort === 'string' ? effort : undefined;
}

// ── Prompt translation: AI SDK v4 prompt → Cloud Code `request` ────────────

/** JSON-Schema keys Gemini rejects; stripped recursively from tool parameters. */
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', '$id', 'additionalProperties']);

function sanitizeToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeToolSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value as Json)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = sanitizeToolSchema(item);
  }
  return out;
}

function parseToolArgs(input: unknown): Json {
  if (typeof input !== 'string' || !input.trim()) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function textPartValue(part: JsonPart): string | null {
  const text = part.text;
  return typeof text === 'string' ? text : null;
}

/**
 * LanguageModelV4 tool-result output → Gemini `functionResponse.response`
 * object. Gemini requires an OBJECT; scalar/string results are wrapped.
 */
function functionResponseObject(output: unknown): Json {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const rec = output as Json;
    if (rec.type === 'text' && typeof rec.value === 'string') return { output: rec.value };
    if (rec.type === 'error-text' && typeof rec.value === 'string') return { error: rec.value };
    if (rec.type === 'execution-denied') return { error: typeof rec.reason === 'string' ? rec.reason : 'execution denied' };
    if (rec.type === 'json' && rec.value !== undefined) {
      return rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
        ? (rec.value as Json)
        : { result: rec.value };
    }
    if (rec.type === 'error-json' && rec.value !== undefined) {
      return rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
        ? (rec.value as Json)
        : { error: rec.value };
    }
    return rec;
  }
  if (typeof output === 'string') return { output };
  if (output === undefined || output === null) return { output: null };
  return { result: output };
}

function filePartToGemini(part: JsonPart): Json | null {
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : '';
  if (!mediaType) return null;
  const data = part.data as Json | undefined;
  if (!data || typeof data !== 'object') return null;
  // Inline base64 payloads only. A url/reference part needs a download the
  // Cloud Code endpoint does not perform for us; a text payload rides as text.
  if (data.type === 'data' && typeof data.data === 'string') {
    return { inlineData: { mimeType: mediaType, data: data.data } };
  }
  if (data.type === 'text' && typeof data.text === 'string') {
    return { text: data.text };
  }
  return null;
}

export function cloudCodeRequestFromPrompt(
  prompt: CloudCodePromptMessage[],
  tools: Array<JsonPart> | undefined,
): { contents: Json[]; systemInstruction: Json | undefined; tools: Json[] | undefined } {
  const systemTexts: string[] = [];
  const contents: Json[] = [];

  // Consecutive same-role messages merge into one contents entry (Gemini
  // tolerates many parts per message; keeping one message per role run keeps
  // the history compact), but do not merge a user message that carries
  // functionResponse parts with a subsequent plain user message.
  const pushContents = (role: 'user' | 'model', parts: Json[]) => {
    const existing = contents[contents.length - 1];
    if (existing && existing.role === role) {
      const existingParts = existing.parts as Json[];
      const hasFunctionResponse = existingParts.some((p) => (p as Json).functionResponse);
      if (hasFunctionResponse && role === 'user') {
        contents.push({ role, parts });
        return;
      }
      existingParts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const message of prompt) {
    if (message.role === 'system') {
      const c: any = (message as any).content;
      if (typeof c === 'string' && c) systemTexts.push(c);
      else if (Array.isArray(c)) {
        for (const p of c) {
          const text = textPartValue(p as any);
          if (text) systemTexts.push(text);
        }
      }
      continue;
    }

    if (message.role === 'user') {
      const parts: Json[] = [];
      for (const part of message.content ?? []) {
        const p: any = part;
        if (p.type === 'text') {
          const text = textPartValue(p);
          if (text) parts.push({ text });
        } else if (p.type === 'file') {
          const converted = filePartToGemini(p);
          if (converted) parts.push(converted);
        }
      }
      if (parts.length) pushContents('user', parts);
      continue;
    }

    if (message.role === 'assistant') {
      const parts: Json[] = [];
      for (const part of message.content ?? []) {
        const p: any = part;
        if (p.type === 'text') {
          const text = textPartValue(p);
          if (text) parts.push({ text });
        } else if (p.type === 'reasoning') {
          const text = textPartValue(p);
          // Replay thought history with Gemini's `thought` marker so the
          // model's own prior reasoning stays attributable on multi-turn calls.
          if (text) parts.push({ text, thought: true });
        } else if (p.type === 'tool-call') {
          parts.push({
            functionCall: {
              name: typeof p.toolName === 'string' ? p.toolName : 'unknown_tool',
              args: parseToolArgs(p.input),
            },
          });
        }
      }
      if (parts.length) pushContents('model', parts);
      continue;
    }

    // tool role — Gemini carries function results in `functionResponse` parts
    // on a user-role message, directly after the assistant's functionCall.
    const parts: Json[] = [];
    for (const part of message.content ?? []) {
      const p: any = part;
      if (p.type !== 'tool-result') continue;
      parts.push({
        functionResponse: {
          name: typeof p.toolName === 'string' ? p.toolName : 'unknown_tool',
          response: functionResponseObject(p.output),
        },
      });
    }
    if (parts.length) {
      const existing = contents[contents.length - 1];
      if (existing && existing.role === 'user') {
        (existing.parts as Json[]).push(...parts);
      } else {
        contents.push({ role: 'user', parts });
      }
    }
  }

  const declarations = (tools ?? [])
    .filter((tool) => tool.type === 'function' && typeof tool.name === 'string')
    .map((tool) => {
      const declaration: Json = { name: tool.name };
      if (typeof tool.description === 'string' && tool.description) {
        declaration.description = tool.description;
      }
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        declaration.parameters = sanitizeToolSchema(tool.inputSchema);
      }
      return declaration;
    });
  const translatedTools = declarations.length ? [{ functionDeclarations: declarations }] : undefined;

  return {
    contents,
    systemInstruction: systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
    tools: translatedTools,
  };
}

// ── Response translation: Cloud Code result → AI SDK v4 result ─────────────

const FINISH_REASON_MAP: Record<string, CloudCodeGenerateResult['finishReason']['unified']> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content-filter',
  BLOCKLIST: 'content-filter',
  PROHIBITED_CONTENT: 'content-filter',
  SPII: 'content-filter',
  RECITATION: 'content-filter',
  MALFORMED_FUNCTION_CALL: 'error',
  OTHER: 'other',
};

export function mapFinishReason(raw: unknown): CloudCodeGenerateResult['finishReason'] {
  const key = typeof raw === 'string' ? raw : '';
  return { unified: FINISH_REASON_MAP[key] ?? 'other', raw: typeof raw === 'string' && raw ? raw : undefined };
}

export function mapUsage(usage: unknown): CloudCodeUsage {
  const rec = (usage && typeof usage === 'object' ? usage : {}) as Json;
  const prompt = typeof rec.promptTokenCount === 'number' ? rec.promptTokenCount : undefined;
  const output = typeof rec.candidatesTokenCount === 'number' ? rec.candidatesTokenCount : undefined;
  const thoughts = typeof rec.thoughtsTokenCount === 'number' ? rec.thoughtsTokenCount : undefined;
  const cached = typeof rec.cachedContentTokenCount === 'number' ? rec.cachedContentTokenCount : undefined;
  return {
    inputTokens: { total: prompt, noCache: prompt, cacheRead: cached, cacheWrite: undefined },
    outputTokens: {
      total: output,
      text: output !== undefined && thoughts !== undefined ? Math.max(0, output - thoughts) : output,
      reasoning: thoughts,
    },
  };
}

type CloudCodePart = Json;

function innerResponse(body: unknown): Json {
  const rec = (body && typeof body === 'object' ? body : {}) as Json;
  const response = rec.response;
  return response && typeof response === 'object' ? (response as Json) : rec;
}

function candidateParts(response: Json): CloudCodePart[] {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const first = candidates[0] as Json | undefined;
  const content = first?.content as Json | undefined;
  const parts = content?.parts;
  return Array.isArray(parts) ? (parts as CloudCodePart[]) : [];
}

function candidateFinishReason(response: Json): unknown {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return undefined;
  const first = candidates[0] as Json | undefined;
  return first?.finishReason;
}

function toolCallId(index: number): string {
  return `call_${Date.now().toString(36)}_${index.toString(36)}`;
}

export function cloudCodeContentFromParts(parts: CloudCodePart[]): JsonPart[] {
  const content: JsonPart[] = [];
  let textBuffer = '';
  const flushText = () => {
    if (textBuffer) {
      content.push({ type: 'text', text: textBuffer });
      textBuffer = '';
    }
  };
  let toolIndex = 0;
  for (const part of parts) {
    if (typeof part.text === 'string' && !part.thought) {
      textBuffer += part.text;
      continue;
    }
    if (typeof part.text === 'string' && part.thought === true) {
      flushText();
      content.push({ type: 'reasoning', text: part.text });
      continue;
    }
    const fn = part.functionCall as Json | undefined;
    if (fn && typeof fn === 'object') {
      flushText();
      content.push({
        type: 'tool-call',
        toolCallId: toolCallId(toolIndex++),
        toolName: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
        input: JSON.stringify(fn.args ?? {}),
      });
    }
  }
  flushText();
  return content;
}

// ── The model ───────────────────────────────────────────────────────────────

function assertProject(descriptor: UpstreamDescriptor): string {
  if (!descriptor.project) {
    throw new Error(
      'The Antigravity credential has no Cloud Code project. Reconnect Google Antigravity to refresh it.',
    );
  }
  return descriptor.project;
}

async function readErrorBody(res: Response): Promise<string> {
  return res.text().catch(() => '');
}

function headersFor(descriptor: UpstreamDescriptor): Record<string, string> {
  const ua =
    descriptor.headers?.['User-Agent'] ??
    descriptor.headers?.['user-agent'] ??
    ANTIGRAVITY_HUB_USER_AGENT;
  return {
    authorization: `Bearer ${descriptor.apiKey}`,
    'content-type': 'application/json',
    'user-agent': ua,
  };
}

function buildRequestBody(
  descriptor: UpstreamDescriptor,
  modelId: string,
  options: CloudCodeCallOptions,
): Json {
  const project = assertProject(descriptor);
  const { contents, systemInstruction, tools } = cloudCodeRequestFromPrompt(options.prompt, options.tools);

  const generationConfig: Json = {};
  if (options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.topP !== undefined) generationConfig.topP = options.topP;
  if (options.topK !== undefined) generationConfig.topK = options.topK;
  if (options.stopSequences?.length) generationConfig.stopSequences = options.stopSequences;
  if (options.seed !== undefined) generationConfig.seed = options.seed;
  if (options.presencePenalty !== undefined) generationConfig.presencePenalty = options.presencePenalty;
  if (options.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = options.frequencyPenalty;
  if (options.responseFormat?.type === 'json') {
    generationConfig.responseMimeType = 'application/json';
    if (options.responseFormat.schema && typeof options.responseFormat.schema === 'object') {
      generationConfig.responseSchema = sanitizeToolSchema(options.responseFormat.schema);
    }
  }

  const request: Json = { contents };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (tools) request.tools = tools;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  return {
    project,
    model: modelId,
    userAgent: 'antigravity',
    requestId: `dosco-${crypto.randomUUID()}`,
    request,
  };
}

async function postCloudCode(
  descriptor: UpstreamDescriptor,
  path: string,
  body: Json,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${trimBaseUrl(descriptor.baseUrl)}/v1internal:${path}`;
  return fetchImpl(url, {
    method: 'POST',
    headers: headersFor(descriptor),
    body: JSON.stringify(body),
    signal,
  });
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * A 404 with the effort-mapped id means the variant does not exist (e.g. an
 * effort the model does not serve). Retry ONCE with the descriptor's own
 * resolved id — the catalog's default variant, which the subscription is
 * known to serve.
 */
function isModelNotFound(status: number, responseBody: string): boolean {
  if (status !== 404) return false;
  return /Requested entity was not found/i.test(responseBody);
}

export interface CloudCodeModelOptions {
  fetch?: typeof globalThis.fetch;
}

export function createCloudCodeModel(descriptor: UpstreamDescriptor, opts: CloudCodeModelOptions = {}): LanguageModel {
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input as Parameters<typeof fetch>[0], init));
  const provider = descriptor.provider;
  const modelId = descriptor.resolvedModel || '';

  const doGenerate = async (options: CloudCodeCallOptions): Promise<CloudCodeGenerateResult> => {
    const effortId = applyEffortToModelId(modelId, reasoningEffortFrom(options));
    const open = async (id: string): Promise<Response> => {
      const res = await postCloudCode(
        descriptor,
        'generateContent',
        buildRequestBody(descriptor, id, options),
        fetchImpl as typeof globalThis.fetch,
        options.abortSignal,
      );
      if (res.ok) return res;
      const errBody = await readErrorBody(res);
      if (isModelNotFound(res.status, errBody) && id !== modelId) return open(modelId);
      throw new CloudCodeHttpError(res.status, errBody, Object.fromEntries(res.headers.entries()));
    };
    const res = await open(effortId);
    const response = innerResponse(await res.json().catch(() => ({})));
    const parts = candidateParts(response);
    return {
      content: cloudCodeContentFromParts(parts),
      finishReason: mapFinishReason(candidateFinishReason(response)),
      usage: mapUsage(response.usageMetadata),
      warnings: [],
    };
  };

  const doStream = async (options: CloudCodeCallOptions) => {
    const effortId = applyEffortToModelId(modelId, reasoningEffortFrom(options));
    const open = async (id: string): Promise<Response> => {
      const res = await postCloudCode(
        descriptor,
        'streamGenerateContent?alt=sse',
        buildRequestBody(descriptor, id, options),
        fetchImpl as typeof globalThis.fetch,
        options.abortSignal,
      );
      if (res.ok) return res;
      const errBody = await readErrorBody(res);
      if (isModelNotFound(res.status, errBody) && id !== modelId) return open(modelId);
      throw new CloudCodeHttpError(res.status, errBody, Object.fromEntries(res.headers.entries()));
    };
    const res = await open(effortId);
    if (!res.body) {
      throw new CloudCodeHttpError(res.status || 502, 'Cloud Code stream returned no body');
    }

    const bodyStream = res.body as ReadableStream<Uint8Array>;
    const reader = typeof (bodyStream as any).getReader === 'function' ? (bodyStream as any).getReader() : null;
    const stream = new ReadableStream<JsonPart>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = '';
        let usage: CloudCodeUsage | undefined;
        let finishReason: CloudCodeGenerateResult['finishReason'] | undefined;
        let textOpened = false;
        let reasoningOpened = false;
        let toolIndex = 0;
        const closeText = () => {
          if (textOpened) {
            controller.enqueue({ type: 'text-end', id: 'txt' });
            textOpened = false;
          }
        };
        const closeReasoning = () => {
          if (reasoningOpened) {
            controller.enqueue({ type: 'reasoning-end', id: 'rsn' });
            reasoningOpened = false;
          }
        };

        let sawToolCall = false;
        const handleFrame = (frame: unknown) => {
          const response = innerResponse(frame);
          if (response.usageMetadata) usage = mapUsage(response.usageMetadata);
          const rawFinish = candidateFinishReason(response);
          for (const part of candidateParts(response)) {
            const p = part as Json;
            const fn = p.functionCall as Json | undefined;
            if (fn && typeof fn === 'object') sawToolCall = true;
            if (typeof p.text === 'string' && p.thought === true) {
              closeText();
              if (!reasoningOpened) {
                controller.enqueue({ type: 'reasoning-start', id: 'rsn' });
                reasoningOpened = true;
              }
              if (p.text) controller.enqueue({ type: 'reasoning-delta', id: 'rsn', delta: p.text });
              continue;
            }
            if (typeof p.text === 'string') {
              closeReasoning();
              if (!textOpened) {
                controller.enqueue({ type: 'text-start', id: 'txt' });
                textOpened = true;
              }
              if (p.text) controller.enqueue({ type: 'text-delta', id: 'txt', delta: p.text });
              continue;
            }
            if (fn && typeof fn === 'object') {
              closeReasoning();
              closeText();
              controller.enqueue({
                type: 'tool-call',
                toolCallId: toolCallId(toolIndex++),
                toolName: typeof fn.name === 'string' ? fn.name : 'unknown_tool',
                input: JSON.stringify(fn.args ?? {}),
              });
            }
          }
          if (typeof rawFinish === 'string' && rawFinish) {
            finishReason = mapFinishReason(rawFinish);
          }
        };

        const ingestLine = (line: string) => {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') return;
          try {
            handleFrame(JSON.parse(data));
          } catch {
            // A malformed frame must not kill the stream — skip it.
          }
        };

        try {
          for (;;) {
            const result = reader ? await reader.read() : await (bodyStream as any).read?.();
            if (!result) break;
            const { done, value } = result;
            if (done) break;
            if (!value) continue;
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
              const newlineAt = buffer.indexOf('\n');
              if (newlineAt === -1) break;
              ingestLine(buffer.slice(0, newlineAt).replace(/\r$/, ''));
              buffer = buffer.slice(newlineAt + 1);
            }
          }
          // A final frame may arrive without a trailing newline.
          if (buffer.trim()) ingestLine(buffer);
        } catch (err) {
          closeReasoning();
          closeText();
          controller.enqueue({ type: 'error', error: err });
        } finally {
          closeReasoning();
          closeText();
        }

        let finalFinish = finishReason ?? { unified: 'other', raw: undefined };
        if (sawToolCall && finalFinish.unified === 'stop') {
          finalFinish = { unified: 'tool-calls', raw: finalFinish.raw };
        }
        controller.enqueue({
          type: 'finish',
          usage: usage ?? {
            inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
          finishReason: finalFinish,
        });
        controller.close();
      },
      cancel(reason) {
        if (reader && typeof (reader as any).cancel === 'function') {
          void (reader as any).cancel(reason).catch(() => {});
          return;
        }
        if (typeof (bodyStream as any).cancel === 'function') {
          void (bodyStream as any).cancel(reason).catch(() => {});
        }
      },
    });

    return {
      stream,
      request: { body: undefined },
      response: { headers: Object.fromEntries(res.headers.entries()) },
    };
  };

  // The single documented cast: this object is structurally an AI SDK
  // provider-v4 language model (specificationVersion 'v4', doGenerate/doStream
  // with v4 content/usage/finish shapes). The type surface lives in
  // @ai-sdk/provider, which this package deliberately does not depend on; the
  // runtime contract is exercised for real by the unit tests driving
  // generateText/streamText from the `ai` package against these objects.
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: doGenerate as unknown as (options: never) => PromiseLike<unknown>,
    doStream: doStream as unknown as (options: never) => PromiseLike<unknown>,
  } as unknown as LanguageModel;
}

// Re-exported for the descriptor builder (apps/api) and tests.
