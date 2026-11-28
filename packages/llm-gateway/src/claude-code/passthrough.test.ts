import { describe, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AuthedPrincipal } from '../domain/principal';
import { createClaudeCodePassthrough, forbiddenMessage, type ClaudeCodeHooks, type ClaudeCodeRequest } from './passthrough';

const PRINCIPAL: AuthedPrincipal = { userId: 'u1', accountId: 'a1', projectId: 'p1', sessionId: 's1' };
const BODY = '{"model":"claude-sonnet-5-5","stream":true,"messages":[{"role":"user","content":"hi ✓"}]}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type Seen = { url: string; headers: Record<string, string>; body: string };

function harness(options: {
  credentials?: Awaited<ReturnType<ClaudeCodeHooks['claudeCredentials']>>;
  /** The host's answer when it is asked a second time (after a forbidden last account). */
  credentialsAgain?: Awaited<ReturnType<ClaudeCodeHooks['claudeCredentials']>>;
  upstream?: (attempt: number) => Response;
  principal?: AuthedPrincipal | null;
}) {
  const seen: Seen[] = [];
  const calls = { authenticate: [] as string[], credentials: [] as Array<string | null>, rateLimits: [] as Array<[string, number]>, refused: [] as Array<[string, string]>, forbidden: [] as Array<[string, string, string]>, usage: [] as Array<[string, number | undefined, boolean]> };
  const hooks: ClaudeCodeHooks = {
    authenticate: async (token) => {
      calls.authenticate.push(token);
      return options.principal === undefined ? PRINCIPAL : options.principal;
    },
    claudeCredentials: async (_principal, input) => {
      calls.credentials.push(input.model);
      if (calls.credentials.length > 1 && options.credentialsAgain) return options.credentialsAgain;
      return options.credentials ?? { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }, { secretId: 'acc-2', apiKey: 'sk-ant-oat01-second' }] };
    },
    notePoolRateLimit: async (_principal, secretId, seconds) => {
      calls.rateLimits.push([secretId, seconds]);
    },
    notePoolUsage: async (_principal, secretId, usage) => {
      calls.usage.push([secretId, usage.windows[0]?.used_percent, usage.limited]);
    },
    claudeRefused: async (_principal, secretId, failedKeySha256) => {
      calls.refused.push([secretId, failedKeySha256]);
    },
    claudeForbidden: async (_principal, secretId, failedKeySha256, message) => {
      calls.forbidden.push([secretId, failedKeySha256, message]);
    },
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({ url: String(url), headers, body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '' });
    return (options.upstream ?? (() => new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } })))(seen.length);
  }) as typeof fetch;
  const handle = createClaudeCodePassthrough(hooks, { upstream: 'https://anthropic.test', fetchImpl });
  return { handle, seen, calls };
}

function request(overrides: Partial<ClaudeCodeRequest> = {}): ClaudeCodeRequest {
  return {
    method: 'POST',
    path: '/v1/messages',
    search: '?beta=true',
    headers: new Headers({
      authorization: 'Bearer kortix-session-token',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.316 (external, sdk-cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'c-1',
      'x-stainless-os': 'Linux',
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: 'secret=1',
      'x-forwarded-for': '10.0.0.1',
      'x-api-key': 'leak',
    }),
    body: new TextEncoder().encode(BODY),
    ...overrides,
  };
}

describe('Claude Code passthrough', () => {
  test('forwards the body unchanged with the account token and only Claude Code headers', async () => {
    const { handle, seen, calls } = harness({});
    const res = await handle(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: ok\n\n');
    expect(calls.authenticate).toEqual(['kortix-session-token']);
    expect(calls.credentials).toEqual(['claude-sonnet-5-5']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://anthropic.test/v1/messages?beta=true');
    expect(seen[0]!.body).toBe(BODY);
    expect(seen[0]!.headers).toEqual({
      authorization: 'Bearer sk-ant-oat01-first',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.316 (external, sdk-cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'c-1',
      'x-stainless-os': 'Linux',
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  test('an x-api-key authenticates when no Authorization header is sent', async () => {
    const { handle, calls } = harness({});
    const headers = new Headers({ 'x-api-key': 'kortix-session-token', 'content-type': 'application/json' });
    expect((await handle(request({ headers }))).status).toBe(200);
    expect(calls.authenticate).toEqual(['kortix-session-token']);
  });

  test('a 429 rests that account and the request moves to the next one', async () => {
    const { handle, seen, calls } = harness({
      upstream: (attempt) => attempt === 1
        ? new Response('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}', { status: 429, headers: { 'retry-after': '120' } })
        : new Response('{"id":"msg"}', { headers: { 'content-type': 'application/json' } }),
    });
    const res = await handle(request());
    expect(res.status).toBe(200);
    expect(calls.rateLimits).toEqual([['acc-1', 120]]);
    expect(seen.map((entry) => entry.headers.authorization)).toEqual(['Bearer sk-ant-oat01-first', 'Bearer sk-ant-oat01-second']);
  });

  test('every answer reports its account plan usage: the refused account limited, the next one at its percent', async () => {
    const { handle, calls } = harness({
      upstream: (attempt) => attempt === 1
        ? new Response('{"type":"error"}', { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1' } })
        : new Response('{"id":"msg"}', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' } }),
    });
    expect((await handle(request())).status).toBe(200);
    expect(calls.usage).toEqual([['acc-1', 100, true], ['acc-2', 25, false]]);
  });

  // The usage read runs after the upstream answered, and here with no catch
  // around it: an unrepresentable reset once threw RangeError out of the whole
  // request instead of relaying the served answer.
  test('a served answer with an unrepresentable reset time is relayed unchanged', async () => {
    const { handle, calls, seen } = harness({
      credentials: { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }] },
      upstream: () => new Response('{"id":"msg"}', {
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.25',
          'anthropic-ratelimit-unified-5h-reset': '1e15',
        },
      }),
    });
    expect((await handle(request())).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(calls.usage).toEqual([['acc-1', 25, false]]);
  });

  test('a 429 without retry-after rests the account 60 s; the last account answers the 429', async () => {
    const { handle, calls } = harness({
      credentials: { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }] },
      upstream: () => new Response('{"type":"error"}', { status: 429 }),
    });
    expect((await handle(request())).status).toBe(429);
    expect(calls.rateLimits).toEqual([['acc-1', 60]]);
  });

  test('a 401 marks that account refused (by digest) and the request moves to the next one', async () => {
    const { handle, calls } = harness({
      upstream: (attempt) => attempt === 1 ? new Response('{"type":"error"}', { status: 401 }) : new Response('{}'),
    });
    expect((await handle(request())).status).toBe(200);
    expect(calls.refused).toEqual([['acc-1', sha256('sk-ant-oat01-first')]]);
  });

  const ORG_OFF = '{"type":"error","error":{"type":"permission_error","message":"Your organization has disabled Claude subscription access for Claude Code."}}';
  const forbidden = () => new Response(ORG_OFF, {
    status: 403, headers: { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '0.18' },
  });

  test('a 403 stores Anthropic\'s reason on that account (by digest) and the request moves to the next one', async () => {
    const { handle, seen, calls } = harness({ upstream: (attempt) => attempt === 1 ? forbidden() : new Response('{"id":"msg"}') });
    const res = await handle(request());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"msg"}');
    expect(calls.forbidden).toEqual([['acc-1', sha256('sk-ant-oat01-first'), 'Your organization has disabled Claude subscription access for Claude Code.']]);
    expect(calls.refused).toEqual([]);
    expect(seen.map((entry) => entry.headers.authorization)).toEqual(['Bearer sk-ant-oat01-first', 'Bearer sk-ant-oat01-second']);
    // The host asks once: the served answer needs no second answer.
    expect(calls.credentials).toHaveLength(1);
  });

  test('a 403 reports no plan usage: a usage report means the account served, and clears its reason', async () => {
    const { handle, calls } = harness({ upstream: (attempt) => attempt === 1 ? forbidden() : new Response('{}', { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' } }) });
    expect((await handle(request())).status).toBe(200);
    expect(calls.usage).toEqual([['acc-2', 25, false]]);
  });

  test('every account forbidden: the host, asked again, names the accounts and the fix', async () => {
    const { handle, seen, calls } = harness({
      upstream: () => forbidden(),
      credentialsAgain: { error: {
        status: 400, code: 'provider_reauth_required',
        message: 'Anthropic refuses the Claude account "Team": Your organization has disabled Claude subscription access for Claude Code.',
        suggestion: 'An admin of its Claude organization must turn Claude Code back on, or share another Claude account with everyone in this workspace.',
      } },
    });
    const res = await handle(request());
    expect(seen).toHaveLength(2);
    expect(calls.forbidden.map(([secretId]) => secretId)).toEqual(['acc-1', 'acc-2']);
    expect(calls.credentials).toHaveLength(2);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message:
      'Anthropic refuses the Claude account "Team": Your organization has disabled Claude subscription access for Claude Code. ' +
      'An admin of its Claude organization must turn Claude Code back on, or share another Claude account with everyone in this workspace.' } });
  });

  test('the last account forbidden while the host still offers accounts: Anthropic\'s 403 is relayed unchanged', async () => {
    const { handle } = harness({
      credentials: { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }] },
      upstream: () => forbidden(),
    });
    const res = await handle(request());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(ORG_OFF);
  });

  test('a 403 that is not Anthropic\'s error JSON (a proxy page) is relayed as received: no mark, no next account', async () => {
    const { handle, seen, calls } = harness({
      upstream: () => new Response('<html><body>403 Forbidden</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    });
    const res = await handle(request());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('<html><body>403 Forbidden</body></html>');
    expect(seen).toHaveLength(1);
    expect(calls.forbidden).toEqual([]);
    expect(calls.credentials).toHaveLength(1);
  });

  test('a 403 body is read only up to 64 KiB: a huge body is cut, never buffered whole', async () => {
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(new Uint8Array(16 * 1024).fill(120));
      },
    });
    const { handle, calls } = harness({ upstream: () => new Response(huge, { status: 403 }) });
    const res = await handle(request());
    expect(res.status).toBe(403);
    expect((await res.arrayBuffer()).byteLength).toBe(64 * 1024);
    // 64 KiB is 4 chunks of 16 KiB; the stream would have produced 1000.
    expect(pulled).toBeLessThan(10);
    expect(calls.forbidden).toEqual([]);
  });

  test('a forbidden account\'s reason is Anthropic\'s message on one line and capped, or none for any other body', () => {
    expect(forbiddenMessage(ORG_OFF)).toBe('Your organization has disabled Claude subscription access for Claude Code.');
    expect(forbiddenMessage(JSON.stringify({ type: 'error', error: { message: '  two\n  lines ' } }))).toBe('two lines');
    expect(forbiddenMessage(JSON.stringify({ type: 'error', error: { message: 'x'.repeat(400) } }))).toHaveLength(300);
    // Not Anthropic's error JSON: no reason, so the account is not marked.
    expect(forbiddenMessage('<html>\n  Forbidden\n</html>')).toBeNull();
    expect(forbiddenMessage('')).toBeNull();
    expect(forbiddenMessage('{"message":"blocked"}')).toBeNull();
    expect(forbiddenMessage('{"type":"error","error":{"message":"  "}}')).toBeNull();
  });

  test('no account: the host reason in the Anthropic error shape, nothing sent upstream', async () => {
    const { handle, seen } = harness({
      credentials: { error: { status: 400, code: 'provider_not_connected', message: 'Connect Claude to use this model.', suggestion: 'Sign in with Claude.' } },
    });
    const res = await handle(request());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'Connect Claude to use this model. Sign in with Claude.' } });
    expect(seen).toHaveLength(0);
  });

  test('every account at its usage limit: a 429 Claude Code reads as a usage limit, with the reset time', async () => {
    setSystemTime(new Date('2026-11-04T14:00:00Z'));
    try {
      const { handle, seen } = harness({
        credentials: { error: {
          status: 429, code: 'provider_pool_rate_limited',
          message: 'All Claude accounts shared with this project reached their usage limit. The first resets in 33 hours.',
          suggestion: 'Choose another model, or connect another Claude account.', restSeconds: 33 * 3600,
        } },
      });
      const res = await handle(request());
      expect(res.status).toBe(429);
      // Claude Code prints its own usage-limit text ("You've hit your usage limit · resets …")
      // only when these headers are present; without them it says "not your usage limit".
      expect(res.headers.get('anthropic-ratelimit-unified-status')).toBe('rejected');
      expect(res.headers.get('anthropic-ratelimit-unified-representative-claim')).toBe('kortix_claude_accounts');
      expect(res.headers.get('anthropic-ratelimit-unified-reset')).toBe(String(Date.parse('2026-11-05T23:00:00Z') / 1000));
      expect(res.headers.get('retry-after')).toBe(String(33 * 3600));
      expect(await res.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'All Claude accounts shared with this project reached their usage limit. The first resets in 33 hours. Choose another model, or connect another Claude account.' } });
      expect(seen).toHaveLength(0);
    } finally {
      setSystemTime();
    }
  });

  test('accounts cooling down for a minute or less: a plain 429 a client retries', async () => {
    const { handle } = harness({
      credentials: { error: {
        status: 429, code: 'provider_pool_rate_limited', message: 'All Claude accounts shared with this project are cooling down.',
        suggestion: 'Retry after the cooldown, or connect another Claude account.', retryAfterSeconds: 30, restSeconds: 30,
      } },
    });
    const res = await handle(request());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('anthropic-ratelimit-unified-status')).toBeNull();
    expect(res.headers.get('anthropic-ratelimit-unified-representative-claim')).toBeNull();
  });

  test('a missing or unknown token answers 401 before any account lookup', async () => {
    const missing = harness({});
    expect((await missing.handle(request({ headers: new Headers({ 'content-type': 'application/json' }) }))).status).toBe(401);
    expect(missing.calls.credentials).toHaveLength(0);
    const unknown = harness({ principal: null });
    expect((await unknown.handle(request())).status).toBe(401);
    expect(unknown.calls.credentials).toHaveLength(0);
  });

  test('the connectivity check answers 200 without a token', async () => {
    const { handle, seen } = harness({});
    const res = await handle(request({ method: 'HEAD', path: '/api/hello', search: '', headers: new Headers(), body: null }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  test('any other path answers 404 and reaches nobody', async () => {
    const { handle, seen, calls } = harness({});
    expect((await handle(request({ path: '/v1/models', method: 'GET', body: null }))).status).toBe(404);
    expect((await handle(request({ path: '/api/oauth/profile', method: 'GET', body: null }))).status).toBe(404);
    expect(seen).toHaveLength(0);
    expect(calls.authenticate).toHaveLength(0);
  });

  test('count_tokens is forwarded the same way', async () => {
    const { handle, seen } = harness({});
    expect((await handle(request({ path: '/v1/messages/count_tokens' }))).status).toBe(200);
    expect(seen[0]!.url).toBe('https://anthropic.test/v1/messages/count_tokens?beta=true');
  });
});
