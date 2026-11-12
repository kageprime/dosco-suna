import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resetAiIndexRateLimitsForTests } from '@/lib/seo/rate-limit';

import { POST } from './route';

const realFetch = globalThis.fetch;
let sent: Array<Record<string, unknown>> = [];
let answer: () => Response;

const stored = () =>
  new Response(JSON.stringify({ ok: true, persisted: true, emailed: false }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  resetAiIndexRateLimitsForTests();
  sent = [];
  answer = stored;
  process.env.BACKEND_URL = 'http://api.test/v1';
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'http://api.test/v1/system/demo-request' && init?.body) sent.push(JSON.parse(String(init.body)));
    return answer();
  }, { preconnect: realFetch.preconnect }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(body: string, ip = '203.0.113.1') {
  return POST(
    new Request('http://localhost/api/demo-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip, 'user-agent': 'synthetic-browser/1.0' },
      body,
    }) as never,
  );
}

describe('POST /api/demo-request', () => {
  test('stores the submission through the API, which answers persisted', async () => {
    const res = await post(JSON.stringify({ email: 'agent@kortix.ai' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, persisted: true });
    expect(sent).toEqual([{ email: 'agent@kortix.ai', user_agent: 'synthetic-browser/1.0' }]);
  });

  test('an API failure returns a retryable 503, never success', async () => {
    for (const failure of [
      () => new Response('{"error":"Unable to save submission; please retry"}', { status: 503, headers: { 'content-type': 'application/json' } }),
      () => new Response('{"error":"Too many requests"}', { status: 429, headers: { 'content-type': 'application/json' } }),
      // A 200 that does not confirm the stored row.
      () => new Response('{"ok":true,"emailed":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]) {
      answer = failure;
      const res = await post(JSON.stringify({ email: 'agent@kortix.ai' }), `203.0.113.${sent.length + 20}`);
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(await res.json()).not.toHaveProperty('ok', true);
    }
  });

  test('refuses a body over 8 KB', async () => {
    const res = await post(JSON.stringify({ email: 'a@b.co', goal: 'x'.repeat(9000) }));
    expect(res.status).toBe(413);
    expect(sent).toEqual([]);
  });

  test('sends only the known fields, truncated, and the visitor user agent', async () => {
    const res = await post(
      JSON.stringify({ email: 'a@b.co', goal: 'g'.repeat(5000), junk: { a: 1 }, form: 'forged' }),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(sent[0]!).sort()).toEqual(['email', 'goal', 'user_agent']);
    expect((sent[0]!.goal as string).length).toBe(2000);
  });

  test('limits one address to 5 submissions a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(JSON.stringify({ email: 'a@b.co' }))).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await post(JSON.stringify({ email: 'a@b.co' }), '203.0.113.9')).status).toBe(200);
  });
});
