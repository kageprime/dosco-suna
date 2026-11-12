import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

import { ApiUnavailableError, type FetchLike, createApiClient } from './api-client';

const principal = { userId: 'u1', accountId: 'a1' };

function client(fetchImpl: FetchLike) {
  return createApiClient({ baseUrl: 'https://api.test', token: 'secret', fetchImpl });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  test('authenticate returns the principal', async () => {
    const result = await client(async () => jsonResponse({ principal })).authenticate('tok');
    expect(result).toEqual(principal);
  });

  test('authenticate returns null for an invalid token', async () => {
    const result = await client(async () => jsonResponse({ principal: null })).authenticate('tok');
    expect(result).toBeNull();
  });

  test('sends the internal bearer token', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      return jsonResponse({ principal });
    };
    await client(fetchImpl).authenticate('tok');
    expect(seenAuth).toBe('Bearer secret');
  });

  test('sends the edge key header only when configured', async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push((init.headers as Record<string, string>)['x-kortix-internal-edge-key']);
      return jsonResponse({ principal });
    };
    await createApiClient({ baseUrl: 'https://api.test', token: 's', edgeKey: 'k1', fetchImpl }).authenticate('t');
    await client(fetchImpl).authenticate('t');
    expect(seen).toEqual(['k1', undefined]);
  });

  test('resolveUpstream returns candidates', async () => {
    const candidates = [{ provider: 'openrouter' }, { provider: 'anthropic' }];
    const result = await client(async () => jsonResponse({ candidates })).resolveUpstream(
      principal,
      'm',
    );
    expect(result).toHaveLength(2);
  });

  test('resolveUpstream re-throws a typed GatewayResolutionError from the body (not a 5xx ApiUnavailableError)', async () => {
    // The API catches GatewayResolutionError in /resolve-upstream and returns
    // it in a 200 body. The client must reconstruct the typed error so the
    // pipeline's dispatch loop surfaces a clean 400 — and must NOT treat it as
    // a 5xx (which would retry 3x and lose the actionable suggestion).
    const c = client(async () =>
      jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_not_connected',
          message: 'Connect Codex to use this model.',
          suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
        },
      }),
    );
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      name: 'GatewayResolutionError',
      code: 'provider_not_connected',
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toBeInstanceOf(
      GatewayResolutionError,
    );
  });

  test('resolveUpstream does NOT retry a resolutionError response (expected 4xx outcome, not a transient 5xx)', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_not_connected',
          message: 'Connect Codex to use this model.',
          suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
        },
      });
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toBeInstanceOf(
      GatewayResolutionError,
    );
    expect(calls).toBe(1);
  });

  test('resolveRoute obtains the model plan from the API control plane', async () => {
    let seenPath = '';
    let seenBody: Record<string, unknown> = {};
    const c = client(async (url, init) => {
      seenPath = new URL(url).pathname;
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        route: {
          policyId: 'platform-default',
          primaryModel: 'codex/gpt-5.6-sol',
          fallbackModels: ['glm-5.3-flash'],
          fallbackOn: 'any-error',
        },
      });
    });

    const route = await c.resolveRoute(principal, {
      requestedModel: 'codex/gpt-5.6-sol',
      requires: { imageInput: false },
    });

    expect(seenPath).toBe('/internal/gateway/resolve-route');
    expect(seenBody).toEqual({
      principal,
      input: { requestedModel: 'codex/gpt-5.6-sol', requires: { imageInput: false } },
    });
    expect(route).toMatchObject({
      policyId: 'platform-default',
      primaryModel: 'codex/gpt-5.6-sol',
      fallbackModels: ['glm-5.3-flash'],
    });
  });

  test('resolveRoute sends requires.imageOutput and re-throws a route refusal as a typed error', async () => {
    let seenBody: Record<string, unknown> = {};
    const c = client(async (_url, init) => {
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        route: null,
        resolutionError: {
          code: 'image_model_unavailable',
          message: 'No image model is available for this project.',
          suggestion: 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.',
        },
      });
    });
    const input = { requestedModel: 'auto', requires: { imageInput: false, imageOutput: true } };

    const refused = await c.resolveRoute(principal, input).catch((error: unknown) => error);

    expect(seenBody).toEqual({ principal, input });
    expect(refused).toBeInstanceOf(GatewayResolutionError);
    expect((refused as GatewayResolutionError).code).toBe('image_model_unavailable');
    expect((refused as GatewayResolutionError).suggestion).toBe(
      'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.',
    );
  });

  test('refreshCredential sends the login, never its token, and keeps the pool identity', async () => {
    let sent: { path: string; body: Record<string, unknown> } | undefined;
    const stale = {
      provider: 'openai-codex', kind: 'openai-responses' as const, baseUrl: 'https://codex.test', apiKey: 'stale-token',
      credentialRef: 's1', poolSecretId: 's1', refreshableCredential: true, billingMode: 'none' as const, markup: 0, resolvedModel: 'm',
    };
    const result = await client(async (url, init) => {
      sent = { path: new URL(url).pathname, body: JSON.parse(String(init.body)) };
      return jsonResponse({ descriptor: { apiKey: 'fresh-token', headers: { 'ChatGPT-Account-ID': 'acct' } } });
    }).refreshCredential(principal, stale);
    expect(sent?.path).toBe('/internal/gateway/refresh-credential');
    expect(sent?.body).toMatchObject({ principal, secretId: 's1' });
    expect(JSON.stringify(sent?.body)).not.toContain('stale-token');
    expect(result).toMatchObject({ apiKey: 'fresh-token', credentialRef: 's1', poolSecretId: 's1', refreshableCredential: true });
  });

  test('refreshCredential is null when the login cannot be refreshed, or names no login', async () => {
    expect(await client(async () => jsonResponse({ descriptor: null })).refreshCredential(principal, {
      provider: 'openai-codex', kind: 'openai-responses', baseUrl: 'https://codex.test', apiKey: 'x', credentialRef: 's1', billingMode: 'none', markup: 0,
    })).toBeNull();
    let called = false;
    expect(await client(async () => { called = true; return jsonResponse({}); }).refreshCredential(principal, {
      provider: 'openai-codex', kind: 'openai-responses', baseUrl: 'https://codex.test', apiKey: 'x', billingMode: 'none', markup: 0,
    })).toBeNull();
    expect(called).toBe(false);
  });

  test('assertBillingActive throws when inactive', async () => {
    const c = client(async () => jsonResponse({ active: false, reason: 'insufficient_credits', message: 'no credits' }));
    const error = await c.assertBillingActive('a1').catch((caught) => caught);
    expect(error).toMatchObject({ message: 'no credits', reason: 'insufficient_credits' });
  });

  test('assertBillingActive resolves when active', async () => {
    const c = client(async () => jsonResponse({ active: true }));
    await expect(c.assertBillingActive('a1')).resolves.toBeUndefined();
  });

  test('assertBillingActive surfaces an admission holdUsd when the API took one (BILLING-CORRECTNESS atomic hold)', async () => {
    const c = client(async () => jsonResponse({ active: true, holdUsd: 0.01 }));
    await expect(c.assertBillingActive('a1')).resolves.toEqual({ holdUsd: 0.01 });
  });

  test('retries a 503 then succeeds', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return calls < 2 ? jsonResponse({}, 503) : jsonResponse({ principal });
    });
    expect(await c.authenticate('tok')).toEqual(principal);
    expect(calls).toBe(2);
  });

  test('throws ApiUnavailableError after exhausting retries', async () => {
    const c = client(async () => jsonResponse({}, 500));
    await expect(c.authenticate('tok')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  // A control-plane call that is SLOW (no response at all before the per-attempt
  // budget) must be retried, exactly like one that fails fast with a 5xx.
  //
  // It was not: `withRetry` settles a timed-out attempt with a `TimeoutError`,
  // and `isRetryable` only accepted `ApiUnavailableError`, so `maxAttempts: 3`
  // was dead code for the one failure mode retries exist for. The un-retried
  // `TimeoutError` then escaped `authorize()` in simple-handler.ts (the only
  // un-guarded hook call in the pipeline) and surfaced as an opaque
  // `503 gateway_error "Gateway unavailable"`.
  //
  // Measured on staging 2026-09-16: 2 of 30 identical requests answered
  // 503 gateway_error at 5.14 s and 5.15 s (the 5 s per-attempt budget), the
  // other 28 answered 400 provider_disabled in 2.0-3.2 s. That is the
  // GW-ACCESS-1 release-gate flake (runs 35012251397, 35036053187).
  test('retries a control-plane call that exceeds the per-attempt timeout', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      // Attempt 1 never answers — a slow API, not a refused connection.
      if (calls === 1) return new Promise<Response>(() => {});
      return jsonResponse({ ok: true, principal });
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    expect(await c.authorize('tok')).toEqual({ ok: true, principal });
    expect(calls).toBe(2);
  });

  test('gives up after maxAttempts when every attempt times out', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(c.authorize('tok')).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(3);
  });

  // The counterpart of the rule above. A settlement write has nobody waiting on
  // it, and a timed-out attempt the API actually committed would be charged
  // twice by a repeat (recordGatewayUsage inserts a usage row and deducts
  // credits; neither is keyed by request id at that layer). Writes therefore
  // keep the narrow policy: retry a refused or 5xx-answered attempt, never a
  // silent one.
  test('does NOT retry a settlement write that times out', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(
      c.recordUsage({ requestId: 'req_1' } as unknown as Parameters<typeof c.recordUsage>[0]),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test('authorize returns the combined gate result (ok)', async () => {
    let seenPath: string | undefined;
    let seenBody: unknown;
    const c = client(async (url, init) => {
      seenPath = new URL(url).pathname;
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ ok: true, principal });
    });
    const result = await c.authorize('tok');
    expect(seenPath).toBe('/internal/gateway/authorize');
    expect(seenBody).toEqual({ token: 'tok', deferBilling: true });
    expect(result).toEqual({ ok: true, principal });
  });

  test('authorize surfaces a typed denial', async () => {
    const c = client(async () =>
      jsonResponse({ ok: false, status: 402, errorCode: 'budget_exceeded', message: 'exhausted' }),
    );
    const result = await c.authorize('tok');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(402);
      expect(result.errorCode).toBe('budget_exceeded');
    }
  });
});

describe('ApiClient.admit', () => {
  const input = { requestedModel: 'm', requires: { imageInput: false } };

  test('maps one /admit answer to the separate hook results', async () => {
    const paths: string[] = [];
    const api = client(async (url) => {
      paths.push(new URL(url).pathname);
      return jsonResponse({
        admission: { ok: true, principal },
        route: { policyId: 'r', primaryModel: 'p' },
        candidates: [],
        resolutionError: { code: 'provider_not_connected', message: 'Connect it', suggestion: 'Connect' },
        billing: { active: false, reason: 'insufficient_credits', message: 'Add credits' },
      });
    });
    const result = await api.admit('tok', input);
    expect(paths).toEqual(['/internal/gateway/admit']);
    expect(result?.admission).toEqual({ ok: true, principal });
    expect(result?.route?.primaryModel).toBe('p');
    expect(result?.upstream).toBeInstanceOf(GatewayResolutionError);
    expect((result?.billing as Error & { reason?: string }).reason).toBe('insufficient_credits');
  });

  test('leaves out what the API did not answer', async () => {
    const result = await client(async () => jsonResponse({ admission: { ok: true, principal }, route: null })).admit('tok', input);
    expect(result).toEqual({ admission: { ok: true, principal }, route: null });
  });

  test('an API without /admit answers null once, without retries, and is not asked again for a minute', async () => {
    let calls = 0;
    const api = client(async () => { calls += 1; return jsonResponse({ error: 'not found' }, 404); });
    expect(await api.admit('tok', input)).toBeNull();
    expect(await api.admit('tok', input)).toBeNull();
    expect(calls).toBe(1);
  });

  // /admit can debit the admission hold as its last step. A repeat after a
  // silent attempt would debit again, and only the last hold reaches the
  // gateway. A timeout therefore answers null once, and the handler uses the
  // separate calls.
  test('a timed-out /admit is not repeated and answers null', async () => {
    let calls = 0;
    const api = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      admitTimeoutMs: 20,
      fetchImpl: async () => { calls += 1; return new Promise<Response>(() => {}); },
    });
    expect(await api.admit('tok', input)).toBeNull();
    expect(calls).toBe(1);
  });

  // /admit debits the hold before it answers. A reset connection or an edge
  // 502/504 can arrive after that debit, so no failure of /admit is repeated:
  // it answers null once, and the handler uses the separate calls.
  test('a reset connection on /admit is not repeated and answers null', async () => {
    let calls = 0;
    const api = client(async () => { calls += 1; throw new TypeError('socket hang up'); });
    expect(await api.admit('tok', input)).toBeNull();
    expect(calls).toBe(1);
  });

  for (const status of [500, 502, 503, 504]) {
    test(`a ${status} on /admit is not repeated and answers null`, async () => {
      let calls = 0;
      const api = client(async () => { calls += 1; return jsonResponse({ error: 'upstream' }, status); });
      expect(await api.admit('tok', input)).toBeNull();
      expect(calls).toBe(1);
    });
  }

  // /admit does four steps in one call, so it gets its own budget, not the
  // per-step budget of the separate calls.
  test('/admit waits for its own timeout, longer than the per-call one', async () => {
    const api = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      timeoutMs: 20,
      admitTimeoutMs: 500,
      fetchImpl: async () => {
        await Bun.sleep(60);
        return jsonResponse({ admission: { ok: true, principal } });
      },
    });
    expect(await api.admit('tok', input)).toEqual({ admission: { ok: true, principal } });
  });

  test('a 404 on any other internal call is still retried', async () => {
    let calls = 0;
    const api = client(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: 'not found' }, 404) : jsonResponse({ ok: true, principal });
    });
    expect(await api.authorize('tok')).toEqual({ ok: true, principal });
    expect(calls).toBe(2);
  });
});

// KORTIX_API_INTERNAL_URL: the gateway reaches the API inside the VPC and
// keeps the public URL as the fallback for a private path that does not answer.
describe('ApiClient private path', () => {
  const input = { requestedModel: 'm', requires: { imageInput: false } };

  function privateClient(fetchImpl: FetchLike) {
    return createApiClient({
      baseUrl: 'https://api.test',
      internalBaseUrl: 'http://api.internal:8008/',
      token: 'secret',
      fetchImpl,
    });
  }

  afterEach(() => setSystemTime());

  test('sends control-plane calls and the ping to the private URL, with the same auth', async () => {
    const seen: string[] = [];
    const api = privateClient(async (url, init) => {
      seen.push(`${url} ${(init.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
      return jsonResponse({ principal });
    });
    await api.authenticate('tok');
    await api.ping();
    expect(seen).toEqual([
      'http://api.internal:8008/internal/gateway/authenticate Bearer secret',
      'http://api.internal:8008/health ',
    ]);
  });

  test('a refused private connection retries on the public URL and stays public for a minute', async () => {
    setSystemTime(new Date('2026-10-20T00:00:00Z'));
    const seen: string[] = [];
    const api = privateClient(async (url) => {
      seen.push(url);
      if (url.startsWith('http://api.internal')) throw new TypeError('ECONNREFUSED');
      return jsonResponse({ principal });
    });
    expect(await api.authenticate('tok')).toEqual(principal);
    expect(await api.authenticate('tok')).toEqual(principal);
    setSystemTime(new Date('2026-10-20T00:01:01Z'));
    await api.authenticate('tok');
    expect(seen).toEqual([
      'http://api.internal:8008/internal/gateway/authenticate',
      'https://api.test/internal/gateway/authenticate',
      'https://api.test/internal/gateway/authenticate',
      'http://api.internal:8008/internal/gateway/authenticate',
      'https://api.test/internal/gateway/authenticate',
    ]);
  });

  test('a refused private ping answers from the public URL at once', async () => {
    const seen: string[] = [];
    const api = privateClient(async (url) => {
      seen.push(url);
      if (url.startsWith('http://api.internal')) throw new TypeError('ECONNREFUSED');
      return jsonResponse({ status: 'ok' });
    });
    expect((await api.ping()).ok).toBe(true);
    expect(seen).toEqual(['http://api.internal:8008/health', 'https://api.test/health']);
  });

  // A private path that drops packets: no error, the request hangs until its
  // signal aborts. Real fetch also rejects at once on an aborted signal, so
  // the public retry needs a signal of its own.
  test('a hanging private ping answers from the public URL on a fresh signal', async () => {
    const seen: string[] = [];
    const api = privateClient((url, init) => {
      seen.push(url);
      const signal = init.signal as AbortSignal;
      if (signal.aborted) return Promise.reject(signal.reason);
      if (url.startsWith('http://api.internal')) {
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      }
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    });
    const result = await api.ping();
    expect(result.ok).toBe(true);
    // The private attempt has a short budget: a blackholed path costs ~1 s, not 3 s.
    expect(result.latencyMs).toBeLessThan(2_000);
    expect(seen).toEqual(['http://api.internal:8008/health', 'https://api.test/health']);
    // The trip holds: the next ping goes straight to the public URL.
    await api.ping();
    expect(seen.at(-1)).toBe('https://api.test/health');
    expect(seen).toHaveLength(3);
  });

  // /admit may have debited the hold before the connection broke, so it is
  // still never repeated: it answers null, and the next call goes public.
  test('a reset private /admit is not repeated, and the next call uses the public URL', async () => {
    const seen: string[] = [];
    const api = privateClient(async (url) => {
      seen.push(url);
      if (url.startsWith('http://api.internal')) throw new TypeError('socket hang up');
      return jsonResponse({ principal });
    });
    expect(await api.admit('tok', input)).toBeNull();
    await api.authenticate('tok');
    expect(seen).toEqual([
      'http://api.internal:8008/internal/gateway/admit',
      'https://api.test/internal/gateway/authenticate',
    ]);
  });

  test('a 5xx from the private URL is the API answering: retried on the private URL', async () => {
    const seen: string[] = [];
    let calls = 0;
    const api = privateClient(async (url) => {
      seen.push(url);
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ principal });
    });
    await api.authenticate('tok');
    expect(seen).toEqual([
      'http://api.internal:8008/internal/gateway/authenticate',
      'http://api.internal:8008/internal/gateway/authenticate',
    ]);
  });
});

// A box's voice call speaks one line per `POST /audio/speech`, and every line
// resolves its TTS model through `resolveUpstream` → `POST
// /internal/gateway/resolve-upstream`. A resolution refusal is a PERSISTENT
// state (the deployment's managed lineup lists no model of that id:
// model_not_found; a plan gate; a disconnected provider), so re-asking per
// line re-ran the API's resolution — and its warn log's first-occurrence
// gate — for the same answer: one session logged 27 warns in 8 h, one per
// line (KRTX-4665). The refusal is remembered per account, project and model,
// when it carries no retry hint (a transient refusal is re-asked).
describe('ApiClient.resolveUpstream remembers a typed refusal', () => {
  afterEach(() => setSystemTime());

  const refused = () =>
    jsonResponse({
      candidates: [],
      resolutionError: {
        code: 'model_not_found',
        message: '"inworld-tts-2" is not a recognized model.',
        suggestion: 'Choose a Kortix audio model.',
      },
    });

  test('a spoken line after the first does not re-ask the API', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    for (let line = 0; line < 5; line++) {
      await expect(c.resolveUpstream(principal, 'inworld-tts-2')).rejects.toMatchObject({
        name: 'GatewayResolutionError',
        code: 'model_not_found',
      });
    }
    expect(calls).toBe(1);
  });

  test('the memory expires: after the TTL the API is asked again', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    await expect(c.resolveUpstream(principal, 'inworld-tts-2')).rejects.toBeInstanceOf(GatewayResolutionError);
    // The memo holds minutes, never forever: a changed deployment state (audio
    // models enabled) must be picked up without a gateway restart.
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    await expect(c.resolveUpstream(principal, 'inworld-tts-2')).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(2);
  });

  test('the memory is per account, project and model', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    await expect(c.resolveUpstream(principal, 'inworld-tts-2')).rejects.toBeInstanceOf(GatewayResolutionError);
    await expect(c.resolveUpstream({ ...principal, accountId: 'a-other' }, 'inworld-tts-2')).rejects.toBeInstanceOf(GatewayResolutionError);
    await expect(c.resolveUpstream({ ...principal, projectId: 'p-other' }, 'inworld-tts-2')).rejects.toBeInstanceOf(GatewayResolutionError);
    await expect(c.resolveUpstream(principal, 'whisper-large-v3')).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(4);
  });

  // Resolution is caller-grained beyond account and project: whose PERSONAL ChatGPT/Claude connection applies
  // (personalUserId — the resolver reads absent as the token user and null as none), which session's provider pool is
  // selected (sessionId) and whether a project gateway key asks (keyId) all change the answer, and a refusal can name
  // the caller's own connection ("Your ChatGPT account "A" needs reconnection."). A refusal learned for one member
  // must therefore never answer another member's request for the same model (Strix review of this PR, CWE-200).
  test('the memory is per caller: one member\'s refusal never answers another member\'s request', async () => {
    let calls = 0;
    const c = client(async (_url, init) => {
      calls += 1;
      const sent = JSON.parse(String(init.body)) as { principal: { personalUserId?: string | null } };
      const who = sent.principal.personalUserId;
      return jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_reauth_required',
          message: who === null
            ? 'No ChatGPT connection is available to this session.'
            : `Your ChatGPT account "conn-${who}" needs reconnection.`,
          suggestion: 'Reconnect it in your ChatGPT accounts, then retry.',
        },
      });
    });
    const owner = { ...principal, projectId: 'p1', personalUserId: 'user-a' };
    const member = { ...principal, projectId: 'p1', personalUserId: 'user-b' };
    // The owner's refusal names the owner's connection...
    await expect(c.resolveUpstream(owner, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      message: 'Your ChatGPT account "conn-user-a" needs reconnection.',
    });
    // ...and must not answer the member's request: the member's own resolution is re-asked.
    await expect(c.resolveUpstream(member, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      message: 'Your ChatGPT account "conn-user-b" needs reconnection.',
    });
    // The member's own second line is still remembered: the per-line storm fix holds per caller.
    await expect(c.resolveUpstream(member, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      message: 'Your ChatGPT account "conn-user-b" needs reconnection.',
    });
    // A null personalUserId (an agent-principal session with no on-behalf-of human) is its own caller too —
    // the resolver reads it as "no personal keys", never as the token user's.
    await expect(c.resolveUpstream({ ...principal, projectId: 'p1', personalUserId: null }, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      message: 'No ChatGPT connection is available to this session.',
    });
    expect(calls).toBe(3);
  });

  // The refusal message embeds the caller-controlled model id verbatim, and the memo bounds entry COUNT (1 000),
  // not bytes: remembering a refusal for a multi-megabyte id would pin those bytes in the gateway process until
  // eviction. Only a plausible id — within the key's own 200-char cap — is remembered; an oversized one re-asks
  // per request (Strix review of this PR, CWE-770).
  test('an oversized model id is never remembered', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    const oversized = `inworld-tts-${'x'.repeat(400)}`;
    await expect(c.resolveUpstream(principal, oversized)).rejects.toBeInstanceOf(GatewayResolutionError);
    await expect(c.resolveUpstream(principal, oversized)).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(2);
  });

  // The key truncates at 200 chars, so a longer id that 200-prefix-matches a remembered one shares its key — and
  // the entry's message names the shorter id. An oversized id is never answered from the memo at all.
  test('an oversized id is not answered from a look-alike memo entry either', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    const exact = 'm'.repeat(200);
    await expect(c.resolveUpstream(principal, exact)).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(1);
    await expect(c.resolveUpstream(principal, `${exact}tail`)).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(2);
  });

  // A restSeconds-only refusal is the usage-limit rest (the client never receives restSeconds; a rest outlives the
  // TTL): it stays remembered — the 5-min re-ask is the bound on per-line resolution. Pinned so a future edit does
  // not silently exclude it and re-open the storm.
  test('a restSeconds-only refusal (no client retry hint) stays remembered', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_pool_rate_limited',
          message: 'All ChatGPT connections reached their usage limit. The first resets in 2 hours.',
          suggestion: 'Choose another model, or connect another ChatGPT account.',
          restSeconds: 7200,
        },
      });
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      code: 'provider_pool_rate_limited',
      retryAfterSeconds: undefined,
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      code: 'provider_pool_rate_limited',
    });
    expect(calls).toBe(1);
  });

  test('the memo is bounded: the oldest entry is evicted and asks the API again', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return refused();
    });
    // Fill the memo past its bound (1 000) with distinct models; the first
    // (oldest) entry is evicted, so its model is asked again.
    for (let m = 0; m <= 1000; m++) {
      await expect(c.resolveUpstream(principal, `model-${m}`)).rejects.toBeInstanceOf(GatewayResolutionError);
    }
    expect(calls).toBe(1001);
    await expect(c.resolveUpstream(principal, 'model-0')).rejects.toBeInstanceOf(GatewayResolutionError);
    expect(calls).toBe(1002);
  });

  test('a refusal with a retry hint is transient: never remembered, the API is asked every time', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_pool_rate_limited',
          message: 'The provider pool is cooling down.',
          suggestion: 'Retry when the cooldown ends.',
          retryAfterSeconds: 30,
        },
      });
    });
    // The pool cooldown is 30 s: a memo would serve the refusal (and its stale
    // retry-after) for the full 5 min, past the pool's stated recovery.
    for (let call = 0; call < 3; call++) {
      await expect(c.resolveUpstream(principal, 'inworld-tts-2')).rejects.toMatchObject({
        code: 'provider_pool_rate_limited',
        retryAfterSeconds: 30,
      });
    }
    expect(calls).toBe(3);
  });

  test('a served resolution is never remembered: every call asks the API', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return jsonResponse({ candidates: [{ provider: 'platinum' }] });
    });
    await c.resolveUpstream(principal, 'inworld-tts-2');
    await c.resolveUpstream(principal, 'inworld-tts-2');
    expect(calls).toBe(2);
  });
});
