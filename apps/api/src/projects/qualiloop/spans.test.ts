import { describe, expect, test } from 'bun:test';
import { isUuid } from '../../shared/validate';
import { buildTurnTrace, kortixSessionIdFor, type LogMessage } from './spans';

const message = (over: Partial<LogMessage>): LogMessage => ({
  schema: 'kortix.session/2', v: 1, message_id: 'm', thread_id: 't', seq: 1, role: 'assistant', kind: 'turn',
  status: 'complete', in_context: true, model: null, usage: null, finish: null, error: null,
  created_at: '2026-11-25T10:00:01.000Z', completed_at: '2026-11-25T10:00:03.000Z',
  producer: { harness: 'pi', version: '1' }, blocks: [],
  ...over,
} as LogMessage);

const attrs = (span: Record<string, any>): Record<string, unknown> =>
  Object.fromEntries((span.attributes as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [a.key, Object.values(a.value)[0]]));

describe('kortixSessionIdFor', () => {
  test('one QualiLoop conversation is one Kortix session id, a valid UUID', () => {
    const id = kortixSessionIdFor('p1', '4821-session-3');
    expect(isUuid(id)).toBe(true);
    expect(kortixSessionIdFor('p1', '4821-session-3')).toBe(id);
    expect(kortixSessionIdFor('p1', '4821-session-4')).not.toBe(id);
    expect(kortixSessionIdFor('p2', '4821-session-3')).not.toBe(id);
  });
});

describe('buildTurnTrace', () => {
  test('turn span → chat span per model call → tool span per call, one trace', () => {
    const body = buildTurnTrace({
      conversationId: '4821-session-3', turnIndex: 1, input: 'What is 2+2?', output: '4',
      startedAtMs: Date.parse('2026-11-25T10:00:00.000Z'), endedAtMs: Date.parse('2026-11-25T10:00:05.000Z'),
      kortixSessionId: 's1', systemPrompt: 'You are My Kortix.',
      messages: [
        message({ role: 'user', blocks: [{ id: 'b0', type: 'text', text: 'What is 2+2?' }] }),
        message({
          model: { provider: 'kortix', model: 'kimi-k3' },
          usage: { input: 100, output: 20, cache_read: 50, cache_write: 0 },
          finish: 'tool_calls',
          blocks: [{
            id: 'b1', type: 'tool_call', call_id: 'c1', name: 'bash', kind: 'shell', input: { command: 'echo 4' }, status: 'complete',
            result: { content: [{ type: 'text', text: '4' }], is_error: false },
            started_at: '2026-11-25T10:00:02.000Z', ended_at: '2026-11-25T10:00:02.500Z',
          }],
        }),
        message({ model: { provider: 'kortix', model: 'kimi-k3' }, blocks: [{ id: 'b2', type: 'text', text: '4' }] }),
      ],
    }, 'dev');

    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans as Array<Record<string, any>>;
    const [turn, chat, tool, chat2] = spans;
    expect(spans).toHaveLength(4);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(attrs(turn!)).toMatchObject({
      'session.id': '4821-session-3', 'qualiloop.input': 'What is 2+2?', 'qualiloop.output': '4',
      'qualiloop.source': 'test-lab', 'qualiloop.turn_index': '1',
    });
    expect(chat!.parentSpanId).toBe(turn!.spanId);
    expect(attrs(chat!)).toMatchObject({
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'kimi-k3',
      'gen_ai.usage.input_tokens': '150', 'gen_ai.usage.output_tokens': '20',
    });
    expect(JSON.parse(attrs(chat!)['gen_ai.input.messages'] as string)).toEqual([{ role: 'system', content: 'You are My Kortix.' }, { role: 'user', content: 'What is 2+2?' }]);
    expect(tool!.parentSpanId).toBe(chat!.spanId);
    expect(attrs(tool!)).toMatchObject({ 'gen_ai.tool.name': 'bash', 'gen_ai.tool.call.result': '4' });
    // The second call saw the tool's result.
    expect(JSON.parse(attrs(chat2!)['gen_ai.input.messages'] as string).at(-1)).toEqual({ role: 'tool', content: 'bash: 4' });
  });
});
