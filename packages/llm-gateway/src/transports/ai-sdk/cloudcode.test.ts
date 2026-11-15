import { describe, expect, test } from 'bun:test';
import { generateText, streamText } from 'ai';
import type { UpstreamDescriptor } from '../../domain';
import {
  ANTIGRAVITY_HUB_USER_AGENT,
  applyEffortToModelId,
  cloudCodeContentFromParts,
  cloudCodeRequestFromPrompt,
  createCloudCodeModel,
  mapFinishReason,
  mapUsage,
  stripEffortSuffix,
} from './cloudcode';
import { toModelMessages } from './messages';
import { openAiJsonFromResult, openAiSseFromFullStream } from './sse';
import { GEMINI_PLACEHOLDER_SIGNATURE, GEMINI_SIGNATURE_FORMAT } from '../../http/gemini-thought-signatures';

function descriptor(overrides: Record<string, unknown> = {}): UpstreamDescriptor {
  return {
    provider: 'antigravity',
    kind: 'google-cloudcode',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiKey: 'tok_test',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'gemini-3.8-flash-medium',
    project: 'aicode-consumers',
    headers: { 'User-Agent': ANTIGRAVITY_HUB_USER_AGENT },
    ...overrides,
  } as unknown as UpstreamDescriptor;
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responder: (req: CapturedRequest) => Response): {
  requests: CapturedRequest[];
  fetch: typeof globalThis.fetch;
} {
  const requests: CapturedRequest[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const captured = { url, headers, body };
    requests.push(captured);
    return responder(captured);
  }) as unknown as typeof globalThis.fetch;
  return { requests, fetch };
}

const BASE = 'https://daily-cloudcode-pa.googleapis.com';

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('applyEffortToModelId', () => {
  test('appends the effort to a bare id', () => {
    expect(applyEffortToModelId('gemini-3.8-flash', 'low')).toBe('gemini-3.8-flash-low');
    expect(applyEffortToModelId('gemini-4-argon', 'high')).toBe('gemini-4-argon-high');
  });

  test('replaces an existing effort variant', () => {
    expect(applyEffortToModelId('gemini-3.8-flash-medium', 'high')).toBe('gemini-3.8-flash-high');
    expect(applyEffortToModelId('claude-sonnet-5-5-low', 'medium')).toBe('claude-sonnet-5-5-medium');
  });

  test('applies extra and max efforts and leaves fixed-variant models alone', () => {
    expect(applyEffortToModelId('gemini-4-hydrogen', 'extra')).toBe('gemini-4-hydrogen-extra');
    expect(applyEffortToModelId('claude-opus-5-5', 'max')).toBe('claude-opus-5-5-max');
    expect(applyEffortToModelId('gpt-oss-120b-medium', 'high')).toBe('gpt-oss-120b-medium');
    expect(applyEffortToModelId('gpt-oss-120b-medium', undefined)).toBe('gpt-oss-120b-medium');
    expect(applyEffortToModelId('gemini-2.5-flash', 'xhigh')).toBe('gemini-2.5-flash');
  });

  test('stripEffortSuffix strips standard, extra, max, and tiered suffixes', () => {
    expect(stripEffortSuffix('gemini-4-hydrogen-extra')).toBe('gemini-4-hydrogen');
    expect(stripEffortSuffix('claude-opus-5-5-max')).toBe('claude-opus-5-5');
    expect(stripEffortSuffix('gemini-3.8-flash-tiered')).toBe('gemini-3.8-flash');
    expect(stripEffortSuffix('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

describe('cloudCodeRequestFromPrompt', () => {
  test('separates system instruction, user text and file parts', () => {
    const { contents, systemInstruction } = cloudCodeRequestFromPrompt(
      [
        { role: 'system', content: 'be terse' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
          ],
        },
      ],
      undefined,
    );
    expect(systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
    ]);
  });

  test('replays assistant history with thought parts and tool calls', () => {
    const { contents } = cloudCodeRequestFromPrompt(
      [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking…' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: '{"city":"Paris"}' },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', output: { type: 'text', value: 'sunny' } }],
        },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
      undefined,
    );
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ text: 'thinking…', thought: true }, { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { output: 'sunny' } } }] },
      { role: 'user', parts: [{ text: 'thanks' }] },
    ]);
  });

  test('backfills blank tool-result toolName from assistant tool-call and never emits empty functionResponse.name', () => {
    const { contents } = cloudCodeRequestFromPrompt(
      [
        { role: 'user', content: [{ type: 'text', text: 'run' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call_42', toolName: 'bash', input: { cmd: 'ls' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'call_42', toolName: '', output: { type: 'text', value: 'ok' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'orphan_99', toolName: '   ', output: { type: 'text', value: 'done' } }],
        },
      ],
      undefined,
    );
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'run' }] },
      { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' } } }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'bash', response: { output: 'ok' } } },
          { functionResponse: { name: 'unknown_tool', response: { output: 'done' } } },
        ],
      },
    ]);
  });

  test('translates function tools and strips Gemini-hostile schema keys', () => {
    const { tools } = cloudCodeRequestFromPrompt([], [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Weather lookup',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: 'string', $id: 'x' } },
          required: ['city'],
        },
      },
    ]);
    expect(tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Weather lookup',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      },
    ]);
  });

  test('collapses TypeBox literal unions (const), nullable unions, $ref, and keeps properties named const', () => {
    const { tools } = cloudCodeRequestFromPrompt([], [
      {
        type: 'function',
        name: 'send_message',
        description: 'Send a message',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          $defs: { ScopeRef: { anyOf: [{ type: 'string', const: 'mine' }, { type: 'string', const: 'project' }] } },
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              description: 'Message kind',
              anyOf: [
                { type: 'string', const: 'message' },
                { type: 'string', const: 'shutdown_request' },
                { type: 'string', const: 'shutdown_response' },
              ],
            },
            mode: {
              oneOf: [
                { const: 'separate' },
                { const: 'same' },
              ],
            },
            assignee: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
            },
            scope: { $ref: '#/$defs/ScopeRef' },
            tools: {
              anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
            },
            const: { type: 'string', default: 'kept' },
            payload: {},
          },
          required: ['kind', 'mode'],
        },
      },
    ]);

    expect(tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'send_message',
            description: 'Send a message',
            parameters: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['message', 'shutdown_request', 'shutdown_response'],
                  description: 'Message kind',
                },
                mode: {
                  type: 'string',
                  enum: ['separate', 'same'],
                },
                assignee: {
                  type: 'string',
                  nullable: true,
                },
                scope: {
                  type: 'string',
                  enum: ['mine', 'project'],
                },
                tools: {
                  anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
                },
                const: { type: 'string' },
                payload: {},
              },
              required: ['kind', 'mode'],
            },
          },
        ],
      },
    ]);
  });
});

describe('response mapping', () => {
  test('cloudCodeContentFromParts buffers text and emits reasoning/tool calls', () => {
    const content = cloudCodeContentFromParts([
      { text: 'Hel' },
      { text: 'lo' },
      { text: 'secret', thought: true },
      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
    ]);
    expect(content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'reasoning', text: 'secret' },
      { type: 'tool-call', toolCallId: expect.any(String), toolName: 'get_weather', input: '{"city":"Paris"}' },
    ]);
  });

  test('mapFinishReason unifies the Cloud Code finish values', () => {
    expect(mapFinishReason('STOP')).toEqual({ unified: 'stop', raw: 'STOP' });
    expect(mapFinishReason('MAX_TOKENS')).toEqual({ unified: 'length', raw: 'MAX_TOKENS' });
    expect(mapFinishReason('SAFETY')).toEqual({ unified: 'content-filter', raw: 'SAFETY' });
    expect(mapFinishReason(undefined)).toEqual({ unified: 'other', raw: undefined });
  });

  test('mapUsage splits thought tokens out of the output count', () => {
    const usage = mapUsage({ promptTokenCount: 9, candidatesTokenCount: 69, thoughtsTokenCount: 58 });
    expect(usage.inputTokens).toMatchObject({ total: 9 });
    expect(usage.outputTokens).toMatchObject({ total: 69, text: 11, reasoning: 58 });
  });
});

// ── End-to-end through the real `ai` package ────────────────────────────────

describe('cloudcode model via generateText', () => {
  test('sends the exact envelope, only the three allowed headers, and unwraps {response}', async () => {
    const { requests, fetch } = fakeFetch(() =>
      new Response(
        JSON.stringify({
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
            modelVersion: 'gemini-3.8-flash-control',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const model = createCloudCodeModel(descriptor(), { fetch });

    const result = await generateText({ model, prompt: 'hi', maxOutputTokens: 16 });

    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.totalTokens).toBe(14);

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.url).toBe(`${BASE}/v1internal:generateContent`);
    expect(Object.keys(req.headers).sort()).toEqual(['authorization', 'content-type', 'user-agent']);
    expect(req.headers.authorization).toBe('Bearer tok_test');
    expect(req.headers['user-agent']).toBe(ANTIGRAVITY_HUB_USER_AGENT);
    expect(req.body.project).toBe('aicode-consumers');
    expect(req.body.model).toBe('gemini-3.8-flash-medium');
    expect(req.body.userAgent).toBe('antigravity');
    expect(String(req.body.requestId)).toMatch(/^dosco-/);
    expect(req.body.request).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 16 },
    });
  });

  test('maps the providerOptions reasoning effort onto the model id', async () => {
    const { requests, fetch } = fakeFetch(() =>
      new Response(
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }),
        { status: 200 },
      ),
    );
    const model = createCloudCodeModel(descriptor({ resolvedModel: 'gemini-3.8-flash-high' }), { fetch });
    await generateText({
      model,
      prompt: 'hi',
      providerOptions: { antigravity: { reasoningEffort: 'low' } },
    });
    expect(requests[0].body.model).toBe('gemini-3.8-flash-low');
  });

  test('retries a 404 model-not-found once with the default variant', async () => {
    const { requests, fetch } = fakeFetch((req) => {
      if (req.body.model === 'gemini-3.8-flash-low') {
        return new Response(JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }),
        { status: 200 },
      );
    });
    const model = createCloudCodeModel(descriptor(), { fetch });
    const result = await generateText({
      model,
      prompt: 'hi',
      providerOptions: { antigravity: { reasoningEffort: 'low' } },
    });
    expect(result.text).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(requests[1].body.model).toBe('gemini-3.8-flash-medium');
  });

  test('surfaces a 429 quota error with the raw upstream body', async () => {
    const { fetch } = fakeFetch(() =>
      new Response(
        JSON.stringify({ error: { code: 429, message: 'Individual quota reached. Resets in 56h32m19s.' } }),
        { status: 429 },
      ),
    );
    const model = createCloudCodeModel(descriptor(), { fetch });
    let caught: unknown;
    try {
      await generateText({ model, prompt: 'hi' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as { statusCode?: number }).statusCode).toBe(429);
    expect(String((caught as { responseBody?: string }).responseBody)).toContain('Individual quota reached');
  });

  test('refuses to build a request without a Cloud Code project', async () => {
    const { fetch } = fakeFetch(() => new Response('{}', { status: 200 }));
    const model = createCloudCodeModel(descriptor({ project: undefined }), { fetch });
    await expect(generateText({ model, prompt: 'hi' })).rejects.toThrow(/no Cloud Code project/);
  });
});

describe('cloudcode model via streamText', () => {
  const SSE = [
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"1,"}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2},"modelVersion":"m"}}',
    '',
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"2"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4}}}',
    '',
    '',
  ].join('\n');

  test('streams text deltas, terminates without [DONE], and carries usage', async () => {
    const { requests, fetch } = fakeFetch(() => new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const model = createCloudCodeModel(descriptor(), { fetch });

    const result = streamText({ model, prompt: 'count' });
    const chunks: string[] = [];
    for await (const delta of result.textStream) chunks.push(delta);

    expect(chunks.join('')).toBe('1,2');
    expect(requests[0].url).toBe(`${BASE}/v1internal:streamGenerateContent?alt=sse`);

    const usage = await result.usage;
    expect(usage.totalTokens).toBe(13);
    const finish = await result.finishReason;
    expect(finish).toBe('stop');
  });

  test('emits a tool call frame and then finishes', async () => {
    const TOOL_SSE = [
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]}}]}}',
      '',
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7}}}',
      '',
    ].join('\n');
    const { fetch } = fakeFetch(() => new Response(TOOL_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const model = createCloudCodeModel(descriptor(), { fetch });

    const result = streamText({ model, prompt: 'weather?' });
    const toolCalls: Array<{ toolName: string; input: unknown }> = [];
    for await (const part of result.fullStream) {
      if (part.type === 'tool-call') {
        toolCalls.push({ toolName: part.toolName, input: part.input });
      }
    }
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('get_weather');
    expect(toolCalls[0].input).toEqual({ city: 'Paris' });
    expect(await result.finishReason).toBe('tool-calls');
  });

  test('round-trips Cloud Code thoughtSignature through SSE/JSON and falls back to placeholder when omitted', async () => {
    const TOOL_SSE = [
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Tokyo"}},"thoughtSignature":"sig-real-123"}]}}]}}',
      '',
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}}',
      '',
    ].join('\n');
    const { fetch: streamFetch } = fakeFetch(
      () => new Response(TOOL_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const model = createCloudCodeModel(descriptor({ resolvedModel: 'gemini-4-argon' }), { fetch: streamFetch });
    const streamed = streamText({ model, prompt: 'weather?' });
    const sseResp = openAiSseFromFullStream(streamed.fullStream, { model: 'gemini-4-argon', provider: 'antigravity' });
    const sseText = await new Response(sseResp).text();
    expect(sseText).toContain(`"format":"${GEMINI_SIGNATURE_FORMAT}"`);
    expect(sseText).toContain('"data":"sig-real-123"');

    // Non-streaming JSON response preserves thoughtSignature too
    const { fetch: jsonFetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } }, thoughtSignature: 'sig-json-456' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const generated = await generateText({
      model: createCloudCodeModel(descriptor({ resolvedModel: 'gemini-4-argon' }), { fetch: jsonFetch }),
      prompt: 'weather?',
    });
    const jsonPayload = openAiJsonFromResult(
      {
        text: generated.text,
        reasoningText: generated.reasoningText,
        toolCalls: generated.toolCalls,
        finishReason: generated.finishReason,
        usage: generated.usage,
      },
      { model: 'gemini-4-argon', provider: 'antigravity' },
    );
    expect((jsonPayload.choices as any)[0].message.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', id: expect.any(String), data: 'sig-json-456', format: GEMINI_SIGNATURE_FORMAT, index: 0 },
    ]);

    // Replay turn with reasoning_details restores thoughtSignature; turn without gets placeholder
    const { messages } = toModelMessages([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c_signed', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
          { id: 'c_plain', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Osaka"}' } },
        ],
        reasoning_details: [{ type: 'reasoning.encrypted', id: 'c_signed', data: 'sig-replayed-789', format: GEMINI_SIGNATURE_FORMAT }],
      },
      { role: 'tool', tool_call_id: 'c_signed', name: 'get_weather', content: 'rain' },
      { role: 'tool', tool_call_id: 'c_plain', name: 'get_weather', content: 'sun' },
    ]);
    const promptMessages = messages.map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant' as const, content: Array.isArray(m.content) ? (m.content as any[]) : [] }
        : { role: m.role as 'user' | 'tool', content: Array.isArray(m.content) ? (m.content as any[]) : [{ type: 'text', text: String(m.content) }] },
    );
    const { contents } = cloudCodeRequestFromPrompt(promptMessages, undefined, 'gemini-4-argon');
    expect((contents[1] as any).parts).toEqual([
      { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } }, thoughtSignature: 'sig-replayed-789' },
      { functionCall: { name: 'get_weather', args: { city: 'Osaka' } }, thoughtSignature: GEMINI_PLACEHOLDER_SIGNATURE },
    ]);

    // End-to-end through real `ai` generateText with `toModelMessages` output:
    const { requests, fetch: roundTripFetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await generateText({
      model: createCloudCodeModel(descriptor({ resolvedModel: 'gemini-4-argon' }), { fetch: roundTripFetch }),
      messages,
    });
    expect((requests[0].body.request as any).contents[1].parts).toEqual([
      { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } }, thoughtSignature: 'sig-replayed-789' },
      { functionCall: { name: 'get_weather', args: { city: 'Osaka' } }, thoughtSignature: GEMINI_PLACEHOLDER_SIGNATURE },
    ]);
  });
});
