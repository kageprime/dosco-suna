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
const {
  discoverAntigravityProject,
  fetchAvailableAntigravityModels,
  __clearAntigravityModelsCacheForTest,
} = await import('../llm-gateway/credentials/antigravity-cloudcode');

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

describe('fetchAvailableAntigravityModels', () => {
  test('normalizes live Cloud Code fetchAvailableModels with variants, orchestrator, and quota availability', async () => {
    __clearAntigravityModelsCacheForTest();
    globalThis.fetch = (async () =>
      fetchJson(200, {
        defaultAgentModelId: 'gemini-4-hydrogen-extra',
        agentModelSorts: [
          {
            displayName: 'Default',
            groups: [
              {
                modelIds: [
                  'gemini-4-argon-low',
                  'gemini-4-argon-medium',
                  'gemini-4-argon-high',
                  'gemini-4-hydrogen-medium',
                  'gemini-4-hydrogen-extra',
                  'orchestrator-argon-live',
                  'gpt-oss-120b-medium',
                  'gemini-4-carbon-medium',
                ],
              },
            ],
          },
        ],
        models: {
          'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', tagTitle: 'New', maxTokens: 1000000, maxOutputTokens: 64000 },
          'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)', recommended: true, tagTitle: 'New', maxTokens: 1000000, maxOutputTokens: 64000 },
          'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', tagTitle: 'New', maxTokens: 1000000, maxOutputTokens: 64000 },
          'gemini-4-hydrogen-medium': { displayName: 'Gemini 4 Hydrogen (Medium)', tagTitle: 'New' },
          'gemini-4-hydrogen-extra': { displayName: 'Gemini 4 Hydrogen (Extra)', tagTitle: 'New' },
          'orchestrator-argon-live': { displayName: 'Orchestrator (Argon)', tagTitle: 'New' },
          'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', tagTitle: 'Notice' },
          'gemini-4-carbon-medium': { displayName: 'Gemini 4 Carbon', disabled: true, tagTitle: 'Unavailable' },
          'internal-shadow-model': { displayName: 'Internal Shadow', isInternal: true },
        },
      })) as unknown as typeof fetch;

    const live = await fetchAvailableAntigravityModels('ya29.fresh', 'proj-1');
    expect(live).not.toBeNull();
    expect(live!.map((m) => m.name)).toEqual([
      'Gemini 4 Argon',
      'Gemini 4 Hydrogen',
      'Orchestrator (Argon)',
      'GPT-OSS 120B (Medium)',
      'Gemini 4 Carbon',
    ]);
    const hydrogen = live!.find((m) => m.id === 'gemini-4-hydrogen');
    expect(hydrogen?.defaultEffort).toBe('extra');
    expect(hydrogen?.efforts).toEqual(['medium', 'extra']);

    const orchestrator = live!.find((m) => m.resolved === 'orchestrator-argon-live');
    expect(orchestrator?.efforts).toBeUndefined();
    expect(orchestrator?.badge).toBe('new');

    const gptOss = live!.find((m) => m.id === 'gpt-oss-120b');
    expect(gptOss?.efforts).toBeUndefined();
    expect(gptOss?.defaultEffort).toBeUndefined();
    expect(gptOss?.badge).toBe('notice');

    const carbon = live!.find((m) => m.id === 'gemini-4-carbon');
    expect(carbon?.unavailable).toBe(true);
    expect(carbon?.badge).toBe('unavailable');
  });

  test('selectCuratedAntigravityPickerModels restricts noisy Cloud Code lists to the curated models in canonical order including Gemini 4 Neon and Orchestrator (Neon)', async () => {
    const { selectCuratedAntigravityPickerModels } = await import('../llm-gateway/credentials/antigravity-cloudcode');
    const noisyLive = [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', resolved: 'gemini-2.5-flash', description: 'legacy', context: 1_000_000, output: 64_000 },
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', resolved: 'gemini-3-pro', description: 'legacy', context: 1_000_000, output: 64_000 },
      { id: 'chat_20706', name: 'Experimental', resolved: 'chat_20706', description: 'extra', context: 1_000_000, output: 64_000 },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', resolved: 'claude-sonnet-4-5', description: 'old', context: 200_000, output: 32_000 },
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', resolved: 'gemini-4-neon', description: 'neon', efforts: ['low', 'medium', 'high', 'extra'] as const, defaultEffort: 'medium' as const, badge: 'new' as const, context: 1_000_000, output: 64_000 },
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', resolved: 'gemini-4-carbon', description: 'carbon', unavailable: true, badge: 'unavailable' as const, context: 2_000_000, output: 64_000 },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', resolved: 'gemini-4-hydrogen', description: 'hydrogen', efforts: ['low', 'medium', 'high', 'extra'] as const, defaultEffort: 'medium' as const, badge: 'new' as const, context: 1_000_000, output: 64_000 },
    ];
    const curated = selectCuratedAntigravityPickerModels(noisyLive as never);
    expect(curated.map((m) => m.name)).toEqual([
      'Gemini 4 Neon',
      'Gemini 4 Argon',
      'Gemini 4 Hydrogen',
      'Orchestrator (Neon)',
      'Orchestrator (Argon)',
      'Gemini 3.8 Flash',
      'Claude Opus 5.5',
      'Claude Sonnet 5.5',
      'GPT-OSS 120B (Medium)',
      'Gemini 4 Carbon',
    ]);
  });
});
