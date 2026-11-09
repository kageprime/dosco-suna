// Characterization tests for the /v1/p/share handlers (KRTX-4477).
//
// The three handlers run the same sandbox-proxy ceremony — the access check,
// the daemon resolve, the 10 s fetch on `${baseUrl}/kortix/share…`, the
// `shareUpstreamResult` mapping and the 502 catch. KRTX-4477 collapses the
// three copies into one helper, and it must not move a single observable:
// every error envelope, every passthrough status, the exact upstream URL and
// the per-action failure messages are pinned here so the dedupe is provably
// behavior-preserving.
//
// The heavy collaborators (auth, ownership, the sandbox row loader behind
// resolveProvider) are stubs; `mock.module` is process-global and this file
// runs isolated.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realOwnership from '../../shared/preview-ownership';
import * as realAuth from '../../middleware/auth';
const RESOLVED = { provider: 'daytona', baseUrl: 'http://daemon.test', serviceKey: 'svc-key' };

// ── knobs the tests flip ──
let accessAllowed = true;
let lookup: { resolved: typeof RESOLVED | null } = { resolved: { ...RESOLVED } };

mock.module('../provider', () => ({
  resolveProvider: async (externalId: string) => {
    if (externalId === 'gone') return null;
    return lookup.resolved ? { ...lookup.resolved } : null;
  },
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realOwnership,
  canAccessPreviewSandbox: async () => accessAllowed,
}));
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  combinedAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'u1');
    c.set('accountId', 'acct-1');
    await next();
  },
}));

const { shareApp } = await import('./share');

const ORIGINAL_FETCH = globalThis.fetch;

/** A fetch that records the request and answers once, or throws. */
let lastFetch: { url: string; headers: Headers; method: string } | null = null;
function answerFetch(answer: Response | Error) {
  lastFetch = null;
  (globalThis as { fetch: unknown }).fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    lastFetch = { url, headers: new Headers(init?.headers), method: init?.method ?? 'GET' };
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const jsonBody = (obj: unknown) => JSON.stringify(obj);

beforeEach(() => {
  accessAllowed = true;
  lookup = { resolved: { ...RESOLVED } };
  lastFetch = null;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('POST /v1/p/share — create', () => {
  const create = (body: string) =>
    shareApp.request('/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });

  test('proxies to the daemon share URL with the service key and passes the answer through', async () => {
    answerFetch(new Response('{"url":"https://share/x"}', { status: 201 }));
    const res = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000, ttl: '1m', label: 'x' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ url: 'https://share/x' });
    expect(lastFetch?.url).toBe('http://daemon.test/kortix/share/3000?ttl=1m&label=x');
    expect(lastFetch?.method).toBe('GET');
    expect(lastFetch?.headers.get('authorization')).toBe('Bearer svc-key');
  });

  test('a daemon 404 naming no share routes answers the 501 envelope, unchanged', async () => {
    answerFetch(new Response(JSON.stringify({ error: 'unknown kortix route' }), { status: 404 }));
    const res = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000 }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'This sandbox does not support share links' });
  });

  test('a 500 from the daemon passes through with its status', async () => {
    answerFetch(new Response('{"error":"boom"}', { status: 500 }));
    const res = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000 }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  test('an unknown or unreachable sandbox answers its own envelopes before any dial', async () => {
    const gone = await create(jsonBody({ sandbox_id: 'gone', port: 3000 }));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'Sandbox not found or not active' });

    // A resolved provider with no baseUrl has nothing to dial (create path).
    lookup = { resolved: { ...RESOLVED, baseUrl: '' } };
    const unreachable = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000 }));
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toEqual({ error: 'Cannot reach sandbox' });
    expect(lastFetch).toBeNull();

    accessAllowed = false;
    const refused = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000 }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Not authorized to access this sandbox' });
    expect(lastFetch).toBeNull();
  });

  test('a failed fetch answers the create-specific 502 envelope', async () => {
    answerFetch(new Error('daemon down'));
    const res = await create(jsonBody({ sandbox_id: 'ext-1', port: 3000 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to create share link' });
  });

  // The OpenAPI body schema owns the first gate (it answers 'Malformed JSON in
  // request body' and the shared Validation failed envelope before the handler
  // runs); the handler's own field guards answer the rest, e.g. an empty
  // sandbox_id string. Pin whichever layer answers today.
  test('the request-shape guards answer their 400s before any dial', async () => {
    answerFetch(new Response('must never be fetched'));
    const badJson = await create('not json');
    expect(badJson.status).toBe(400);
    expect(await badJson.text()).toBe('Malformed JSON in request body');
    const noSandbox = await create(jsonBody({ port: 3000 }));
    expect(noSandbox.status).toBe(400);
    const noSandboxBody = (await noSandbox.json()) as { message: string; issues: Array<{ path: string[] }> };
    expect(noSandboxBody.message).toBe('Validation failed');
    expect(noSandboxBody.issues[0]?.path).toEqual(['sandbox_id']);
    const badPort = await create(jsonBody({ sandbox_id: 'ext-1', port: 70000 }));
    expect(badPort.status).toBe(400);
    const emptySandbox = await create(jsonBody({ sandbox_id: '', port: 3000 }));
    expect(await emptySandbox.json()).toEqual({ error: 'sandbox_id is required (string)' });
    expect(lastFetch).toBeNull();
  });
});

describe('GET /v1/p/share — list', () => {
  const list = (query = '?sandbox_id=ext-1') => shareApp.request(`/${query}`);

  test('fetches the daemon share base with no trailing slash and passes the answer through', async () => {
    answerFetch(new Response('{"shares":[]}', { status: 200 }));
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shares: [] });
    expect(lastFetch?.url).toBe('http://daemon.test/kortix/share');
    expect(lastFetch?.method).toBe('GET');
  });

  test('the error envelopes carry over: 404 unknown-route → 501, refused → 403, fetch failure → 502', async () => {
    answerFetch(new Response(JSON.stringify({ error: 'unknown kortix route' }), { status: 404 }));
    const notFound = await list();
    expect(notFound.status).toBe(501);
    expect(await notFound.json()).toEqual({ error: 'This sandbox does not support share links' });

    accessAllowed = false;
    const refused = await list();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Not authorized to access this sandbox' });
    accessAllowed = true;

    answerFetch(new Error('daemon down'));
    const failed = await list();
    expect(await failed.json()).toEqual({ error: 'Failed to load share links' });
  });

  test('a missing sandbox_id answers its 400 envelope before any dial', async () => {
    answerFetch(new Response('must never be fetched'));
    const res = await list('?sandbox_id=');
    expect(await res.json()).toEqual({ error: 'sandbox_id is required (string)' });
    expect(lastFetch).toBeNull();
  });
});

describe('DELETE /v1/p/share/{token} — revoke', () => {
  const revoke = (token: string, query = '?sandbox_id=ext-1') =>
    shareApp.request(`/${token}${query}`, { method: 'DELETE' });

  test('sends the DELETE against the encoded token and passes the answer through', async () => {
    answerFetch(new Response('{"revoked":true}', { status: 200 }));
    const res = await revoke('tok%20a', '?sandbox_id=ext-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(lastFetch?.url).toBe('http://daemon.test/kortix/share/tok%20a');
    expect(lastFetch?.method).toBe('DELETE');
  });

  test('the error envelopes carry over, including the revoke-specific 502', async () => {
    answerFetch(new Response(JSON.stringify({ error: 'unknown kortix route' }), { status: 404 }));
    const notFound = await revoke('tok');
    expect(notFound.status).toBe(501);
    expect(await notFound.json()).toEqual({ error: 'This sandbox does not support share links' });

    accessAllowed = false;
    const refused = await revoke('tok');
    expect(refused.status).toBe(403);
    accessAllowed = true;

    answerFetch(new Error('daemon down'));
    const failed = await revoke('tok');
    expect(await failed.json()).toEqual({ error: 'Failed to revoke share link' });
  });

  test('missing token and missing sandbox_id answer their 400s before any dial', async () => {
    answerFetch(new Response('must never be fetched'));
    // An empty token has no route to match: 404 from the router.
    const noTokenRoute = await revoke('', '?sandbox_id=ext-1');
    expect(noTokenRoute.status).toBe(404);
    // A present-but-empty sandbox_id passes the query schema and hits the handler.
    const emptySandbox = await revoke('tok', '?sandbox_id=');
    expect(emptySandbox.status).toBe(400);
    expect(await emptySandbox.json()).toEqual({ error: 'sandbox_id is required (string)' });
    // A missing sandbox_id query fails the OpenAPI schema first.
    const noQueryParam = await revoke('tok', '?onomy=1');
    expect(noQueryParam.status).toBe(400);
    const body = (await noQueryParam.json()) as { message: string; issues: Array<{ path: string[] }> };
    expect(body.message).toBe('Validation failed');
    expect(body.issues[0]?.path).toEqual(['sandbox_id']);
    expect(lastFetch).toBeNull();
  });
});
