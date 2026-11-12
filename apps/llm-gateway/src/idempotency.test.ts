import { describe, expect, test } from 'bun:test';

// `config` (imported transitively by `./server`) reads required env vars at
// module-load time — set them before the dynamic import below so this file
// can run standalone without a real Kortix API / gateway token.
process.env.KORTIX_API_URL = process.env.KORTIX_API_URL ?? 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? 'test-internal-token';

const { buildServer } = await import('./server');
const { createIdempotencyReplay } = await import('./idempotency');

const CHAT_BODY = JSON.stringify({
  model: 'test-model',
  max_tokens: 8,
  messages: [{ role: 'user', content: 'hi' }],
});

// KRTX-4612: the gateway ignored a client `Idempotency-Key`, so a retried
// inference request executed the provider again and settled a second usage
// record for tokens the one logical operation only consumed once. The edge
// now replays the first 2xx answer for the same credential + key + body: one
// execution, one metering record. Only the API's internal endpoints and the
// provider are faked; routes, gateway and API client run for real.
describe('inference Idempotency-Key replay', () => {
  /** Boots the real server with the control plane and provider stubbed, and exact call counts. */
  async function serve(opts: { providerStatus?: number } = {}) {
    const counts = { provider: 0, usage: 0, images: { generations: 0, edits: 0 } };
    // The credential gate the replay's reauthorize and the pipeline both hit.
    const gates = { admitted: true, up: true };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/internal/gateway/admit')) {
        if (!gates.admitted) {
          return Response.json({
            admission: { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' },
          });
        }
        return Response.json({
          admission: { ok: true, principal: { userId: 'u', accountId: 'a' } },
          route: { policyId: 'direct', primaryModel: 'test-model' },
          candidates: [
            { provider: 'mock', kind: 'openai-compat', baseUrl: 'https://provider.test/v1', apiKey: 'key', billingMode: 'none', markup: 0 },
          ],
        });
      }
      if (url.endsWith('/internal/gateway/authorize')) {
        if (!gates.up) throw new Error('control plane down');
        if (!gates.admitted) return Response.json({ ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' });
        return Response.json({ ok: true, principal: { userId: 'u', accountId: 'a' } });
      }
      if (url.endsWith('/internal/gateway/resolve-route')) {
        return Response.json({ route: { policyId: 'direct', primaryModel: 'test-model' } });
      }
      if (url.endsWith('/internal/gateway/resolve-upstream')) {
        return Response.json({
          candidates: [
            { provider: 'mock', kind: 'openai-compat', baseUrl: 'https://provider.test/v1', apiKey: 'key', billingMode: 'none', markup: 0 },
          ],
        });
      }
      if (url.endsWith('/internal/gateway/budget-check')) return Response.json({ exceeded: false });
      if (url.endsWith('/internal/gateway/usage')) {
        counts.usage += 1;
        return Response.json({ ok: true });
      }
      if (url.endsWith('/internal/gateway/trace')) return Response.json({ ok: true });
      if (url === 'https://provider.test/v1/chat/completions') {
        // The chat-image adapter (an openai-compat candidate) posts its image
        // execution to the same URL: `modalities` marks it. A string content
        // is a generations call; the content array (the reference images) is
        // an edits call. Each operation gets its own answer to read.
        const sent = JSON.parse(String(init?.body ?? '{}')) as {
          modalities?: unknown;
          messages?: { content?: unknown }[];
        };
        if (sent.modalities) {
          const operation = typeof sent.messages?.[0]?.content === 'string' ? 'generations' : 'edits';
          counts.images[operation] += 1;
          return Response.json({
            choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${Buffer.from(`image-${operation}`).toString('base64')}` } }] } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          });
        }
        counts.provider += 1;
        if (opts.providerStatus !== undefined && opts.providerStatus !== 200) {
          return new Response('provider down', { status: opts.providerStatus });
        }
        return Response.json({
          id: `cmpl-${counts.provider}`,
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 20, completion_tokens: 25 },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const { app } = buildServer();
    const post = (body: string, idempotencyKey?: string) =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body,
      });
    const appPost = (path: string, body: string, idempotencyKey?: string) =>
      app.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body,
      });
    return { counts, post, appPost, gates, stop: () => (globalThis.fetch = originalFetch) };
  }

  test('a retry with the same Idempotency-Key is served the first answer — one provider call, one usage record', async () => {
    const gateway = await serve();
    try {
      const first = await gateway.post(CHAT_BODY, 'retry-1');
      const second = await gateway.post(CHAT_BODY, 'retry-1');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as Record<string, unknown>;
      const secondBody = (await second.json()) as Record<string, unknown>;
      // The replay is the first answer: same completion id, same body — not a fresh execution.
      expect(secondBody).toEqual(firstBody);
      expect(gateway.counts.provider).toBe(1);
      expect(gateway.counts.usage).toBe(1);
    } finally {
      gateway.stop();
    }
  });

  test('a different Idempotency-Key on the same body executes again', async () => {
    const gateway = await serve();
    try {
      const first = await gateway.post(CHAT_BODY, 'retry-1');
      const second = await gateway.post(CHAT_BODY, 'retry-2');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await second.json())).not.toEqual(await first.json());
      expect(gateway.counts.provider).toBe(2);
      expect(gateway.counts.usage).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('a request without an Idempotency-Key executes again', async () => {
    const gateway = await serve();
    try {
      expect((await gateway.post(CHAT_BODY)).status).toBe(200);
      expect((await gateway.post(CHAT_BODY)).status).toBe(200);
      expect(gateway.counts.provider).toBe(2);
      expect(gateway.counts.usage).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('the same Idempotency-Key with a different body executes again', async () => {
    const gateway = await serve();
    try {
      const other = JSON.stringify({
        model: 'test-model',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'a different prompt' }],
      });
      expect((await gateway.post(CHAT_BODY, 'retry-1')).status).toBe(200);
      expect((await gateway.post(other, 'retry-1')).status).toBe(200);
      expect(gateway.counts.provider).toBe(2);
      expect(gateway.counts.usage).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('concurrent requests with the same Idempotency-Key share one execution', async () => {
    const gateway = await serve();
    try {
      const [first, second] = await Promise.all([
        gateway.post(CHAT_BODY, 'retry-1'),
        gateway.post(CHAT_BODY, 'retry-1'),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(gateway.counts.provider).toBe(1);
      expect(gateway.counts.usage).toBe(1);
    } finally {
      gateway.stop();
    }
  });

  test('the same key and body bytes on a second wire protocol execute again — no cross-protocol replay', async () => {
    const gateway = await serve();
    try {
      // Byte-identical body valid on both ingresses: only the protocol scopes
      // the entries apart, so the messages route must execute its own answer
      // in the Anthropic message shape, never replay the chat answer.
      const shared = JSON.stringify({
        model: 'stub-model',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const chat = await gateway.appPost('/v1/chat/completions', shared, 'retry-1');
      const messages = await gateway.appPost('/v1/messages', shared, 'retry-1');
      expect(chat.status).toBe(200);
      expect(messages.status).toBe(200);
      const messagesBody = (await messages.json()) as Record<string, unknown>;
      expect(messagesBody.type).toBe('message');
      expect(gateway.counts.provider).toBe(2);
      expect(gateway.counts.usage).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('the same key and body bytes on the second image operation execute again — no cross-operation replay', async () => {
    const gateway = await serve();
    try {
      // Byte-identical body valid on BOTH image ingresses: generations reads
      // `prompt` and ignores `images[]`, edits requires it — only the
      // operation scopes the entries apart, so an edits request must execute
      // its own answer, never replay the generations answer.
      const shared = JSON.stringify({
        model: 'stub-model',
        prompt: 'a red cube on a table',
        images: [{ image_url: 'https://ref.test/cube.png' }],
      });
      const generations = await gateway.appPost('/v1/images/generations', shared, 'img-key-1');
      const edits = await gateway.appPost('/v1/images/edits', shared, 'img-key-1');
      expect(generations.status).toBe(200);
      expect(edits.status).toBe(200);
      const generationsBody = (await generations.json()) as { data: { b64_json: string }[] };
      const editsBody = (await edits.json()) as { data: { b64_json: string }[] };
      expect(Buffer.from(generationsBody.data[0].b64_json, 'base64').toString()).toBe('image-generations');
      expect(Buffer.from(editsBody.data[0].b64_json, 'base64').toString()).toBe('image-edits');
      expect(gateway.counts.images).toEqual({ generations: 1, edits: 1 });
      expect(gateway.counts.usage).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('a cache hit is not served after the credential stops being admitted — the retry surfaces the pipeline denial', async () => {
    const gateway = await serve();
    try {
      expect((await gateway.post(CHAT_BODY, 'retry-1')).status).toBe(200);
      expect((await gateway.post(CHAT_BODY, 'retry-1')).status).toBe(200);
      expect(gateway.counts.provider).toBe(1);
      // The credential is revoked (or suspended / over budget) after the
      // first execution: every gate now denies the request.
      gateway.gates.admitted = false;
      const denied = await gateway.post(CHAT_BODY, 'retry-1');
      expect(denied.status).toBe(401);
      const deniedBody = (await denied.json()) as Record<string, unknown>;
      expect(deniedBody.code).toBe('invalid_token');
      // The cached answer was neither served nor kept: no second execution,
      // no second usage record, and the entry is gone.
      expect(gateway.counts.provider).toBe(1);
      expect(gateway.counts.usage).toBe(1);
      const again = await gateway.post(CHAT_BODY, 'retry-1');
      expect(again.status).toBe(401);
      expect(gateway.counts.provider).toBe(1);
    } finally {
      gateway.stop();
    }
  });

  test('a control-plane failure during the hit check falls through to the pipeline and keeps the entry', async () => {
    const gateway = await serve();
    try {
      const first = await gateway.post(CHAT_BODY, 'retry-1');
      const firstBody = await first.json();
      expect(gateway.counts.provider).toBe(1);
      // The credential check cannot be answered (a transient control-plane
      // outage): the entry must not be served, and must not be dropped either.
      gateway.gates.up = false;
      const fallen = await gateway.post(CHAT_BODY, 'retry-1');
      expect(fallen.status).toBe(200); // the pipeline's own admission still allows this stub
      expect(gateway.counts.provider).toBe(2);
      gateway.gates.up = true;
      const recovered = await gateway.post(CHAT_BODY, 'retry-1');
      expect(recovered.status).toBe(200);
      // The kept entry still serves the first answer, not the fall-through's.
      expect(await recovered.json()).toEqual(firstBody);
      expect(gateway.counts.provider).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('a provider failure is not replayed — the retry re-executes', async () => {
    const gateway = await serve({ providerStatus: 500 });
    try {
      const first = await gateway.post(CHAT_BODY, 'retry-1');
      const second = await gateway.post(CHAT_BODY, 'retry-1');
      // The provider's status is relayed verbatim (rawProviderError).
      expect(first.status).toBe(500);
      expect(second.status).toBe(500);
      expect(gateway.counts.provider).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  test('a streaming request is not replayed — each attempt executes', async () => {
    const gateway = await serve();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://provider.test/v1/chat/completions') {
        gateway.counts.provider += 1;
        const frames = [
          'data: {"choices":[{"delta":{"role":"assistant","content":"he"}}]}\n\n',
          `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":25}}\n\n`,
          'data: [DONE]\n\n',
        ];
        return new Response(frames.join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return originalFetch(input);
    }) as typeof fetch;
    try {
      const streamBody = JSON.stringify({
        model: 'test-model',
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const res = await gateway.post(streamBody, 'retry-1');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        await res.text();
      }
      expect(gateway.counts.provider).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      gateway.stop();
    }
  });
});

describe('idempotency replay cache', () => {
  test('an entry expires after its TTL and the next request executes again', async () => {
    let clock = 1_000_000;
    const replay = createIdempotencyReplay(() => clock);
    let calls = 0;
    const call = async () => {
      calls += 1;
      return new Response(JSON.stringify({ n: calls }), { status: 200 });
    };
    const request = { authorization: 'Bearer token' as string | undefined, rawBody: '{}' };
    await replay('chat', 'key-1', request, call);
    await replay('chat', 'key-1', request, call);
    expect(calls).toBe(1);
    clock += 60 * 60 * 1000 + 1; // past the TTL
    await replay('chat', 'key-1', request, call);
    expect(calls).toBe(2);
  });
});
