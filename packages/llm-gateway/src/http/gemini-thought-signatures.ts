import type { UpstreamDescriptor } from '../domain';

/**
 * Gemini thought signatures through Google's OpenAI-compatible endpoint.
 *
 * Gemini 3 refuses a request whose earlier function calls come back without
 * the `thought_signature` it returned with them (HTTP 400 "Function call is
 * missing a thought_signature"). Google returns it on each tool call as
 * `extra_content.google.thought_signature` and reads it back from the same
 * place (https://ai.google.dev/gemini-api/docs/thought-signatures). pi keeps
 * no `extra_content`, but it does keep and replay OpenAI-style
 * `reasoning_details` (the format OpenRouter uses for the same signatures).
 *
 * So for a Google upstream the gateway:
 *  1. copies each returned signature into `reasoning_details` as a
 *     `reasoning.encrypted` entry keyed by the tool call id (response side);
 *  2. puts each signature a client replays in `reasoning_details` back on its
 *     tool call as `extra_content.google.thought_signature`, and removes those
 *     entries (request side);
 *  3. gives a Gemini 3 tool call that still has no signature (a call made by
 *     another model earlier in the session, or replayed by a client that keeps
 *     neither field) Google's documented placeholder, so the request is served.
 */

export const GEMINI_SIGNATURE_FORMAT = 'google-gemini-v1';
/** Google's documented value for a function call that has no real signature. */
export const GEMINI_PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';

const GOOGLE_OPENAI_HOST = 'generativelanguage.googleapis.com';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGoogleOpenAiUpstream(descriptor: Pick<UpstreamDescriptor, 'provider' | 'baseUrl'>): boolean {
  return descriptor.provider === 'google' || URL.parse(descriptor.baseUrl ?? '')?.hostname === GOOGLE_OPENAI_HOST;
}

function signatureOf(toolCall: Json): string | undefined {
  const extra = toolCall.extra_content;
  const google = isObject(extra) ? extra.google : undefined;
  const signature = isObject(google) ? google.thought_signature : undefined;
  return typeof signature === 'string' && signature ? signature : undefined;
}

function isGeminiSignatureDetail(detail: unknown): detail is Json & { id: string; data: string } {
  return isObject(detail) && detail.type === 'reasoning.encrypted' && detail.format === GEMINI_SIGNATURE_FORMAT &&
    typeof detail.id === 'string' && typeof detail.data === 'string';
}

/** The request body to send Google: replayed signatures restored onto their tool calls. */
export function restoreGeminiThoughtSignatures(body: Json, model: string | undefined): Json {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const needsPlaceholder = /gemini-3/i.test(model ?? String(body.model ?? ''));
  let changed = false;
  const next = messages.map((message) => {
    if (!isObject(message) || message.role !== 'assistant') return message;
    const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
    const signatures = new Map(details.filter(isGeminiSignatureDetail).map((detail) => [detail.id, detail.data]));
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;
    if (!signatures.size && !(needsPlaceholder && toolCalls?.length)) return message;
    const out: Json = { ...message };
    if (signatures.size) {
      const rest = details.filter((detail) => !isGeminiSignatureDetail(detail));
      if (rest.length) out.reasoning_details = rest;
      else delete out.reasoning_details;
    }
    if (toolCalls) {
      out.tool_calls = toolCalls.map((call) => {
        if (!isObject(call) || signatureOf(call)) return call;
        const signature = (typeof call.id === 'string' ? signatures.get(call.id) : undefined) ??
          (needsPlaceholder ? GEMINI_PLACEHOLDER_SIGNATURE : undefined);
        if (!signature) return call;
        const extra = isObject(call.extra_content) ? call.extra_content : {};
        const google = isObject(extra.google) ? extra.google : {};
        return { ...call, extra_content: { ...extra, google: { ...google, thought_signature: signature } } };
      });
    }
    changed = true;
    return out;
  });
  return changed ? { ...body, messages: next } : body;
}

/** A completion message or stream delta with each tool call's signature copied into `reasoning_details`. */
function exposeOn(container: Json): boolean {
  const toolCalls = Array.isArray(container.tool_calls) ? container.tool_calls : [];
  const entries = toolCalls.flatMap((call, position) => {
    if (!isObject(call)) return [];
    const signature = signatureOf(call);
    if (!signature || typeof call.id !== 'string' || !call.id) return [];
    const index = typeof call.index === 'number' ? call.index : position;
    return [{ type: 'reasoning.encrypted', id: call.id, data: signature, format: GEMINI_SIGNATURE_FORMAT, index }];
  });
  if (!entries.length) return false;
  const existing = Array.isArray(container.reasoning_details) ? container.reasoning_details : [];
  container.reasoning_details = [...existing, ...entries];
  return true;
}

/** One chat completion object or stream chunk, with Gemini signatures exposed. */
export function exposeGeminiThoughtSignatures(payload: Json): Json {
  const choices = payload.choices;
  if (!Array.isArray(choices)) return payload;
  let changed = false;
  const next = choices.map((choice) => {
    if (!isObject(choice)) return choice;
    const field = isObject(choice.delta) ? 'delta' : isObject(choice.message) ? 'message' : null;
    if (!field) return choice;
    const container = { ...(choice[field] as Json) };
    if (!exposeOn(container)) return choice;
    changed = true;
    return { ...choice, [field]: container };
  });
  return changed ? { ...payload, choices: next } : payload;
}

function exposeInLine(line: string): string {
  const match = /^data: ?(\{.*\})\r?$/.exec(line);
  if (!match) return line;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!isObject(parsed)) return line;
    const exposed = exposeGeminiThoughtSignatures(parsed);
    return exposed === parsed ? line : `data: ${JSON.stringify(exposed)}`;
  } catch {
    return line;
  }
}

/** A Google response with every returned signature also in `reasoning_details`. */
export async function exposeGeminiThoughtSignaturesInResponse(response: Response, streaming: boolean): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  if (!streaming) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isObject(parsed)) return new Response(JSON.stringify(exposeGeminiThoughtSignatures(parsed)), init);
    } catch {
      // Not JSON: relayed as received.
    }
    return new Response(text, init);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const lines = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const end = pending.lastIndexOf('\n');
      if (end < 0) return;
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      controller.enqueue(encoder.encode(complete.split('\n').map(exposeInLine).join('\n')));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(exposeInLine(pending)));
    },
  });
  return new Response(response.body.pipeThrough(lines), init);
}
