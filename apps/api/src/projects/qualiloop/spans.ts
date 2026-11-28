/**
 * One QualiLoop test turn as an OTLP/JSON trace: the turn span QualiLoop
 * matches by `session.id`, one `chat` span per model call and one
 * `execute_tool` span per tool call, built from the session log after the
 * turn ended. Attribute names follow QualiLoop's reference (turn span) and the
 * OpenTelemetry GenAI conventions (model and tool spans).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { SessionLogPage } from '@kortix/api-contract/session-log';
import { toOtelAttributes, toUnixNano } from '../../lib/otel';

export type LogMessage = SessionLogPage['messages'][number];

/** The Kortix session of a QualiLoop conversation: a UUID v4-shaped hash, so a repeat id finds the same session. */
export function kortixSessionIdFor(projectId: string, conversationId: string): string {
  const h = createHash('sha256').update(`qualiloop:${projectId}:${conversationId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface QualiloopTurn {
  conversationId: string;
  turnIndex: number;
  input: string;
  output: string;
  startedAtMs: number;
  endedAtMs: number;
  /** The turn's own log messages, oldest first. */
  messages: LogMessage[];
  /** The session's system prompt, verbatim: QualiLoop matches it against the prompts it was sent. */
  systemPrompt: string | null;
  kortixSessionId: string;
}

/** A tool result or prompt kept in a span is cut to this many characters. */
const MAX_TEXT = 8_000;

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const ms = (iso: string | null | undefined, fallback: number) => (iso ? Date.parse(iso) || fallback : fallback);
const cut = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

function messageText(message: LogMessage): string {
  return message.blocks.map((block) => (block.type === 'text' ? block.text : '')).filter(Boolean).join('\n\n');
}

function toolResultText(block: Extract<LogMessage['blocks'][number], { type: 'tool_call' }>): string {
  const content = block.result?.model_content ?? block.result?.content ?? [];
  return cut(content.map((item) => (item.type === 'text' ? item.text : `[${item.mime}]`)).join('\n'));
}

/** The OTLP/JSON body for one turn: a `resourceSpans` export request. */
export function buildTurnTrace(turn: QualiloopTurn, environment: string) {
  const traceId = hex(16);
  const turnSpanId = hex(8);
  const spans: Array<Record<string, unknown>> = [{
    traceId,
    spanId: turnSpanId,
    name: 'qualiloop turn',
    kind: 2,
    startTimeUnixNano: toUnixNano(turn.startedAtMs),
    endTimeUnixNano: toUnixNano(turn.endedAtMs),
    attributes: toOtelAttributes({
      'session.id': turn.conversationId,
      'qualiloop.input': turn.input,
      'qualiloop.output': turn.output,
      'qualiloop.source': 'test-lab',
      'qualiloop.turn_index': turn.turnIndex,
      'kortix.session_id': turn.kortixSessionId,
    }),
    status: { code: 1 },
  }];

  // What the model was given before each call: the user's message, then each earlier step's text and tool results.
  const history: Array<{ role: string; content: string }> = turn.systemPrompt ? [{ role: 'system', content: turn.systemPrompt }] : [];
  for (const message of turn.messages) {
    if (message.role !== 'assistant') {
      const text = messageText(message);
      if (text) history.push({ role: message.role, content: cut(text) });
      continue;
    }
    const chatSpanId = hex(8);
    const start = ms(message.created_at, turn.startedAtMs);
    const model = message.model ? `${message.model.provider}/${message.model.model}` : 'unknown';
    const text = messageText(message);
    spans.push({
      traceId,
      spanId: chatSpanId,
      parentSpanId: turnSpanId,
      name: `chat ${model}`,
      kind: 3,
      startTimeUnixNano: toUnixNano(start),
      endTimeUnixNano: toUnixNano(ms(message.completed_at, start)),
      attributes: toOtelAttributes({
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': message.model?.provider,
        'gen_ai.request.model': message.model?.model,
        'gen_ai.response.model': message.model?.model,
        'gen_ai.usage.input_tokens': message.usage ? message.usage.input + message.usage.cache_read + message.usage.cache_write : undefined,
        'gen_ai.usage.output_tokens': message.usage?.output,
        'gen_ai.usage.cache_read_input_tokens': message.usage?.cache_read,
        'gen_ai.response.finish_reasons': message.finish ?? undefined,
        'gen_ai.input.messages': JSON.stringify(history),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: text }]),
      }),
      status: { code: message.status === 'error' ? 2 : 1 },
    });
    if (text) history.push({ role: 'assistant', content: cut(text) });

    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue;
      const toolStart = ms(block.started_at, start);
      const result = toolResultText(block);
      spans.push({
        traceId,
        spanId: hex(8),
        parentSpanId: chatSpanId,
        name: `execute_tool ${block.name}`,
        kind: 1,
        startTimeUnixNano: toUnixNano(toolStart),
        endTimeUnixNano: toUnixNano(ms(block.ended_at, toolStart)),
        attributes: toOtelAttributes({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': block.name,
          'gen_ai.tool.call.id': block.call_id,
          'gen_ai.tool.call.arguments': cut(typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})),
          'gen_ai.tool.call.result': result,
        }),
        status: { code: block.result?.is_error ? 2 : 1 },
      });
      history.push({ role: 'tool', content: `${block.name}: ${result}` });
    }
  }

  return {
    resourceSpans: [{
      resource: {
        attributes: toOtelAttributes({ 'service.name': 'kortix-agent', 'deployment.environment': environment }),
      },
      scopeSpans: [{ scope: { name: 'kortix-qualiloop' }, spans }],
    }],
  };
}
