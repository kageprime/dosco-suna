import { expect, test } from 'bun:test';
import { observeClaudeUsage } from './usage';

test('relays fragmented Anthropic bytes and merges start/delta usage once', async () => {
  const text = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":11,"cache_read_input_tokens":23,"cache_creation_input_tokens":37,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":53}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const recorded: unknown[] = [];
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
  const response = observeClaudeUsage(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), (usage) => { recorded.push(usage); });
  expect(await response.text()).toBe(text);
  expect(recorded).toEqual([{ model: 'claude-opus-5-5', promptTokens: 71, completionTokens: 53, cachedTokens: 23, cacheWriteTokens: 37, complete: true }]);
});

test('nonstream JSON uses the same inclusive input accounting', async () => {
  const recorded: unknown[] = [];
  const text = JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 7, output_tokens: 13, cache_read_input_tokens: 17, cache_creation_input_tokens: 19 } });
  const response = observeClaudeUsage(new Response(text, { headers: { 'content-type': 'application/json' } }), (usage) => { recorded.push(usage); });
  expect(await response.text()).toBe(text);
  expect(recorded).toEqual([{ model: 'claude-sonnet-5-5', promptTokens: 43, completionTokens: 13, cachedTokens: 17, cacheWriteTokens: 19, complete: true }]);
});

test('a canceled stream records partial observed usage and cancels upstream', async () => {
  const recorded: unknown[] = [];
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n')); }, cancel() { canceled = true; } });
  const response = observeClaudeUsage(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), (usage) => { recorded.push(usage); });
  const reader = response.body?.getReader();
  await reader?.read();
  await reader?.cancel();
  expect(canceled).toBe(true);
  expect(recorded).toEqual([{ model: null, promptTokens: 3, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, complete: false }]);
});

test('unusable usage never fabricates a priced observation', async () => {
  const recorded: unknown[] = [];
  const response = observeClaudeUsage(new Response('data: not-json\n\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } }), (usage) => { recorded.push(usage); });
  await response.text();
  expect(recorded).toEqual([]);
});


test('telemetry only observes complete numeric usage fields', async () => {
  const recorded: unknown[] = [];
  const response = observeClaudeUsage(Response.json({ model: 'claude-opus-5-5', usage: { input_tokens: -1, output_tokens: '53', cache_read_input_tokens: 2.5 } }), (usage) => { recorded.push(usage); });
  await response.text();
  expect(recorded).toEqual([{ model: 'claude-opus-5-5', promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, complete: false }]);
});

for (const usage of [{ input_tokens: 100 }, { output_tokens: 53 }, { input_tokens: null, output_tokens: 53 }]) {
  test(`missing required counters stay incomplete: ${JSON.stringify(usage)}`, async () => {
    const recorded: unknown[] = [];
    const text = JSON.stringify({ usage });
    const response = observeClaudeUsage(Response.json({ usage }), (value) => recorded.push(value));
    expect(await response.text()).toBe(text);
    expect(recorded).toEqual([expect.objectContaining({ complete: false, cachedTokens: 0, cacheWriteTokens: 0 })]);
  });
}

test('malformed delta invalidates previously observed usage without changing relayed bytes', async () => {
  const text = 'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":broken}\n\ndata: {"type":"message_stop"}\n\n';
  const recorded: unknown[] = [];
  const response = observeClaudeUsage(new Response(text, { headers: { 'content-type': 'text/event-stream' } }), (value) => recorded.push(value));
  expect(await response.text()).toBe(text);
  expect(recorded).toEqual([{ model: null, promptTokens: 11, completionTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, complete: false }]);
});

test('explicit zero required counters and absent optional caches are complete', async () => {
  const recorded: unknown[] = [];
  await observeClaudeUsage(Response.json({ usage: { input_tokens: 0, output_tokens: 0 } }), (value) => recorded.push(value)).text();
  expect(recorded).toEqual([{ model: null, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, complete: true }]);
});
