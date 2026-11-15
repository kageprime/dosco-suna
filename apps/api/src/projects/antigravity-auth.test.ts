/**
 * Google Antigravity device grant (RFC 8628) — the mapping the product
 * depends on: the challenge fields the OAuth route seals into the flow id,
 * the pending/failed/success shapes the poll route switches on, and an
 * authJson the LLM gateway's own parser accepts.
 */
import { afterEach, describe, expect, test } from 'bun:test';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fetchJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const {
  parseAntigravityRedirectInput,
  pollAntigravityDeviceAuth,
  startAntigravityDeviceAuth,
} = await import('./antigravity-auth');
const { parseAntigravityAuth } = await import('../llm-gateway/credentials/antigravity');
const { discoverAntigravityProject } = await import('../llm-gateway/credentials/antigravity-cloudcode');

describe('startAntigravityDeviceAuth', () => {
  test('maps the device-code response to the challenge the OAuth route seals', async () => {
    globalThis.fetch = (async () => fetchJson(200, {
      device_code: 'DEV-1',
      user_code: 'ABCD-JKLM',
      verification_url: 'https://www.google.com/device',
      interval: 5,
    })) as unknown as typeof fetch;
    expect(await startAntigravityDeviceAuth()).toEqual({
      verificationUrl: 'https://www.google.com/device',
      userCode: 'ABCD-JKLM',
      deviceAuthId: 'DEV-1',
      intervalMs: 5000,
    });
  });

  test('a TV/Limited Input client refusal tells the member to paste instead', async () => {
    globalThis.fetch = (async () => new Response('{"error":"invalid_client"}', { status: 401 })) as unknown as typeof fetch;
    await expect(startAntigravityDeviceAuth()).rejects.toThrow('pasting your Antigravity token');
  });
});

describe('pollAntigravityDeviceAuth', () => {
  test('authorization_pending is pending', async () => {
    globalThis.fetch = (async () => fetchJson(400, { error: 'authorization_pending' })) as unknown as typeof fetch;
    expect(await pollAntigravityDeviceAuth({ deviceAuthId: 'd', userCode: 'u' })).toEqual({ status: 'pending' });
  });

  test('HTTP 428 is pending', async () => {
    globalThis.fetch = (async () => fetchJson(428, {})) as unknown as typeof fetch;
    expect(await pollAntigravityDeviceAuth({ deviceAuthId: 'd', userCode: 'u' })).toEqual({ status: 'pending' });
  });

  test('access_denied is failed', async () => {
    globalThis.fetch = (async () => fetchJson(403, { error: 'access_denied' })) as unknown as typeof fetch;
    expect(await pollAntigravityDeviceAuth({ deviceAuthId: 'd', userCode: 'u' })).toEqual({
      status: 'failed',
      error: 'Google authorization request was denied.',
    });
  });

  test('the authorized authJson is the shape the LLM gateway parses', async () => {
    const payload = Buffer.from(JSON.stringify({ email: 'dev@example.com' })).toString('base64url');
    globalThis.fetch = (async () => fetchJson(200, {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      id_token: `h.${payload}.s`,
    })) as unknown as typeof fetch;
    const res = await pollAntigravityDeviceAuth({ deviceAuthId: 'd', userCode: 'u' });
    expect(res.status).toBe('authorized');
    if (res.status !== 'authorized') return;
    const parsed = JSON.parse(res.authJson) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed)).toEqual(['antigravity']);
    expect(parsed.antigravity.type).toBe('oauth');
    expect(parsed.antigravity.access).toBe('at-1');
    expect(parsed.antigravity.refresh).toBe('rt-1');
    expect(parsed.antigravity.email).toBe('dev@example.com');
    expect(parsed.antigravity.expires).toBeGreaterThan(Date.now());
    expect(parseAntigravityAuth(res.authJson)?.access).toBe('at-1');
  });
});

describe('parseAntigravityRedirectInput', () => {
  test('accepts full redirect URL, scheme-less URL, query fragment, and bare code', () => {
    expect(
      parseAntigravityRedirectInput('http://localhost:51121/oauth-callback?state=st1&code=4/0A-full'),
    ).toEqual({ code: '4/0A-full', state: 'st1', error: undefined, errorDescription: undefined });

    expect(
      parseAntigravityRedirectInput('localhost:51121/oauth-callback?state=st2&code=4/0A-noscheme'),
    ).toEqual({ code: '4/0A-noscheme', state: 'st2', error: undefined, errorDescription: undefined });

    expect(parseAntigravityRedirectInput('?code=4/0A-query&state=st3')).toEqual({
      code: '4/0A-query',
      state: 'st3',
      error: undefined,
      errorDescription: undefined,
    });

    expect(parseAntigravityRedirectInput('4/0A-bare-code')).toEqual({ code: '4/0A-bare-code' });
  });
});

describe('discoverAntigravityProject', () => {
  test('falls back to onboardUser + LRO poll when loadCodeAssist has no companion project', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url.endsWith(':loadCodeAssist')) {
        return fetchJson(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] });
      }
      if (url.endsWith(':onboardUser')) {
        return fetchJson(200, { name: 'operations/onboard-1', done: false });
      }
      if (url.endsWith('/v1internal/operations/onboard-1')) {
        return fetchJson(200, {
          name: 'operations/onboard-1',
          done: true,
          response: { cloudaicompanionProject: { id: 'onboarded-proj-123' } },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const project = await discoverAntigravityProject('ya29.fresh-token', { pollDelayMs: 0 });
    expect(project).toBe('onboarded-proj-123');
    expect(calls.some((u) => u.endsWith(':onboardUser'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/v1internal/operations/onboard-1'))).toBe(true);
  });
});
