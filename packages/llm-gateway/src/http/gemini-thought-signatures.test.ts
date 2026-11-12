import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { callUpstream } from './call-upstream';
import {
  GEMINI_PLACEHOLDER_SIGNATURE,
  GEMINI_SIGNATURE_FORMAT,
  exposeGeminiThoughtSignatures,
  restoreGeminiThoughtSignatures,
} from './gemini-thought-signatures';

const google: UpstreamDescriptor = {
  provider: 'google',
  kind: 'openai-compat',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gemini-3-pro-preview',
};

const signedCall = {
  id: 'call_1', type: 'function', index: 0,
  function: { name: 'read', arguments: '{}' },
  extra_content: { google: { thought_signature: 'SIG_A' } },
};

describe('Gemini thought signatures', () => {
  test('a returned signature is also exposed as a reasoning_details entry keyed by the tool call', () => {
    const chunk = { choices: [{ index: 0, delta: { tool_calls: [signedCall] } }] };
    expect(exposeGeminiThoughtSignatures(chunk).choices).toEqual([{
      index: 0,
      delta: {
        tool_calls: [signedCall],
        reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'SIG_A', format: GEMINI_SIGNATURE_FORMAT, index: 0 }],
      },
    }]);
    const plain = { choices: [{ delta: { content: 'hi' } }] };
    expect(exposeGeminiThoughtSignatures(plain)).toBe(plain);
  });

  test('a replayed reasoning_details signature goes back onto its tool call, and the entry is removed', () => {
    const body = {
      model: 'gemini-3-pro-preview',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
          reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'SIG_A', format: GEMINI_SIGNATURE_FORMAT }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
    };
    const restored = restoreGeminiThoughtSignatures(body, 'gemini-3-pro-preview');
    const assistant = (restored.messages as Array<Record<string, unknown>>)[1]!;
    expect(assistant.reasoning_details).toBeUndefined();
    expect(assistant.tool_calls).toEqual([{
      id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' },
      extra_content: { google: { thought_signature: 'SIG_A' } },
    }]);
  });

  test('a Gemini 3 tool call with no signature gets the placeholder; a Gemini 2.5 one is left alone', () => {
    const body = { messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] }] };
    const three = restoreGeminiThoughtSignatures(body, 'gemini-3-flash');
    expect((three.messages as Array<{ tool_calls: Array<Record<string, unknown>> }>)[0]!.tool_calls[0]!.extra_content)
      .toEqual({ google: { thought_signature: GEMINI_PLACEHOLDER_SIGNATURE } });
    expect(restoreGeminiThoughtSignatures(body, 'gemini-2.5-pro')).toBe(body);
  });

  test('callUpstream round-trips a signature through a Google stream and the next request', async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [signedCall] } }] })}\n\ndata: [DONE]\n\n`;
    const fetchImpl = async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)));
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const response = await callUpstream({ model: 'google/gemini-3-pro-preview', stream: true, messages: [] }, google, { fetchImpl });
    const text = await response.text();
    const frame = JSON.parse(text.split('\n')[0]!.slice('data: '.length));
    const details = frame.choices[0].delta.reasoning_details;
    expect(details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1', data: 'SIG_A', format: GEMINI_SIGNATURE_FORMAT, index: 0 }]);

    // pi replays the entry on the assistant message; Google receives extra_content.
    await callUpstream({
      model: 'google/gemini-3-pro-preview',
      stream: true,
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }], reasoning_details: details }],
    }, google, { fetchImpl }).then((r) => r.text());
    const replayed = (sentBodies[1]!.messages as Array<{ tool_calls: Array<Record<string, unknown>>; reasoning_details?: unknown }>)[0]!;
    expect(replayed.tool_calls[0]!.extra_content).toEqual({ google: { thought_signature: 'SIG_A' } });
    expect(replayed.reasoning_details).toBeUndefined();
  });
});
