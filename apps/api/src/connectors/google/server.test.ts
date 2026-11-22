import { describe, expect, test } from 'bun:test';
import { createConnectorEgressFetch } from '../egress';
import { GOOGLE_SERVICES, googleMcpUrl, googleServiceForUrl } from './host';
import { GOOGLE_TOOLS, dispatchGoogleMcp } from './server';
import { createGoogleClient, type GoogleFetch } from './client';

const TOKEN = 'ya29.test-token';

function rpc(service: string, method: string, params: Record<string, unknown> = {}, token: string | null = TOKEN) {
  return new Request(`https://google.mcp.kortix.com/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** A fake Google: answers by URL path, records every request. */
function fakeGoogle(routes: Record<string, (url: URL, init: RequestInit) => Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: GoogleFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const route = Object.keys(routes).find((path) => url.pathname.endsWith(path));
    return route ? routes[route]!(url, init) : Response.json({ error: { message: 'not found', errors: [{ reason: 'notFound' }] } }, { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('Kortix Google MCP servers', () => {
  test('every service URL round-trips and nothing else is a Kortix Google URL', () => {
    for (const service of GOOGLE_SERVICES) expect(googleServiceForUrl(googleMcpUrl(service))).toBe(service);
    expect(googleServiceForUrl('https://google.mcp.kortix.com/gmail?x=1')).toBeNull();
    expect(googleServiceForUrl('https://evil.example/gmail')).toBeNull();
    expect(googleServiceForUrl('https://gmailmcp.googleapis.com/mcp/v1')).toBeNull();
  });

  test('tool names are unique per service and every tool declares its risk', () => {
    for (const service of GOOGLE_SERVICES) {
      const names = GOOGLE_TOOLS[service].map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      for (const tool of GOOGLE_TOOLS[service]) {
        expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
        expect(tool.inputSchema.type).toBe('object');
      }
      // No free-form request tool: it would let a call around per-tool policy rules.
      expect(names).not.toContain('request');
    }
  });

  test('initialize and tools/list answer without calling Google', async () => {
    const google = fakeGoogle({});
    const init = await (await dispatchGoogleMcp(rpc('gmail', 'initialize', { protocolVersion: '2025-06-18' }), google)).json();
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const list = await (await dispatchGoogleMcp(rpc('gmail', 'tools/list'), google)).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('fetch_emails');
    expect(names).toContain('send_email');
    expect(google.calls).toHaveLength(0);
  });

  test('a request without a bearer token is a 401', async () => {
    const res = await dispatchGoogleMcp(rpc('gmail', 'tools/list', {}, null));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  test('fetch_emails lists, reads each message and answers the Composio shape', async () => {
    const google = fakeGoogle({
      '/users/me/messages': () => Response.json({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'p2', resultSizeEstimate: 7 }),
      '/users/me/messages/m1': () =>
        Response.json({ id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 's', internalDate: '0', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@x.test' }], body: { data: Buffer.from('body').toString('base64url') } } }),
    });
    const res = await dispatchGoogleMcp(rpc('gmail', 'tools/call', { name: 'fetch_emails', arguments: { query: 'is:unread', max_results: 5, page_token: 'p1' } }), google);
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    const out = body.result.structuredContent;
    expect(out.nextPageToken).toBe('p2');
    expect(out.resultSizeEstimate).toBe(7);
    expect(out.messages[0]).toMatchObject({ messageId: 'm1', threadId: 't1', subject: 'Hi', sender: 'a@x.test', messageText: 'body' });
    const list = google.calls[0]!.url;
    expect(list.searchParams.get('q')).toBe('is:unread');
    expect(list.searchParams.get('maxResults')).toBe('5');
    expect(list.searchParams.get('pageToken')).toBe('p1');
    expect((google.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('send_email posts a raw MIME message', async () => {
    const google = fakeGoogle({
      '/settings/sendAs': () => Response.json({ sendAs: [] }),
      '/messages/send': () => Response.json({ id: 'sent1', threadId: 't9', labelIds: ['SENT'] }),
    });
    const res = await dispatchGoogleMcp(
      rpc('gmail', 'tools/call', { name: 'send_email', arguments: { recipient_email: 'b@x.test', subject: 'S', body: 'B' } }),
      google,
    );
    const out = (await res.json()).result.structuredContent;
    expect(out).toMatchObject({ id: 'sent1', threadId: 't9', display_url: 'https://mail.google.com/mail/u/0/#all/sent1' });
    const send = google.calls.find((c) => c.url.pathname.endsWith('/messages/send'))!;
    const raw = JSON.parse(String(send.init.body)).raw as string;
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: b@x.test');
    expect(mime).toContain('Subject: S');
  });

  test('a missing argument is a tool error, not a transport error', async () => {
    const res = await dispatchGoogleMcp(rpc('gmail', 'tools/call', { name: 'send_email', arguments: { subject: 'no recipient' } }), fakeGoogle({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('recipient_email');
  });

  test('Google 401 becomes HTTP 401; a missing scope is a tool error that says reconnect', async () => {
    const expired = fakeGoogle({ '/profile': () => Response.json({ error: { message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }, { status: 401 }) });
    expect((await dispatchGoogleMcp(rpc('gmail', 'tools/call', { name: 'get_profile', arguments: {} }), expired)).status).toBe(401);
    const scope = fakeGoogle({
      '/profile': () => Response.json({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 }),
    });
    const body = await (await dispatchGoogleMcp(rpc('gmail', 'tools/call', { name: 'get_profile', arguments: {} }), scope)).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('reconnect');
  });

  test('a rate limit is retried, then the answer is returned', async () => {
    let attempts = 0;
    const google = fakeGoogle({
      '/profile': () => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403, headers: { 'Retry-After': '0' } })
          : Response.json({ emailAddress: 'me@x.test' });
      },
    });
    const body = await (await dispatchGoogleMcp(rpc('gmail', 'tools/call', { name: 'get_profile', arguments: {} }), google)).json();
    expect(body.result.structuredContent.emailAddress).toBe('me@x.test');
    expect(attempts).toBe(2);
  });

  test('the connector egress answers a Kortix Google URL in-process', async () => {
    const egress = createConnectorEgressFetch();
    const res = await egress(googleMcpUrl('calendar'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const names = JSON.parse(await res.text()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('events_list');
  });
});


describe('Google gateway cancellation', () => {
  test('an already-aborted MCP request makes no provider request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gateway deadline'));
    let calls = 0;
    const request = new Request(rpc('gmail', 'tools/call', { name: 'fetch_emails' }), { signal: controller.signal });
    const response = await dispatchGoogleMcp(request, { fetchImpl: async () => {
      calls++;
      return Response.json({ messages: [] });
    } });
    expect(calls).toBe(0);
    expect((await response.json()).result.isError).toBe(true);
  });

  test('in-flight cancellation reaches fetch and prevents later detail batches', async () => {
    const controller = new AbortController();
    const request = new Request(rpc('gmail', 'tools/call', { name: 'fetch_emails', arguments: { max_results: 20 } }), { signal: controller.signal });
    let calls = 0;
    const response = await dispatchGoogleMcp(request, { fetchImpl: async (_url, init) => {
      calls++;
      expect(init.signal).toBe(request.signal);
      if (calls === 1) return Response.json({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `message-${i}`, threadId: `thread-${i}` })) });
      controller.abort(new Error('gateway deadline'));
      init.signal?.throwIfAborted();
      return Response.json({ id: 'unexpected' });
    } });
    expect(calls).toBe(2);
    expect((await response.json()).result.isError).toBe(true);
  });

  test('a pending provider fetch observes the gateway abort', async () => {
    const controller = new AbortController();
    let observedAbort = false;
    const request = new Request(rpc('drive', 'tools/call', { name: 'list_files' }), { signal: controller.signal });
    const response = await dispatchGoogleMcp(request, { fetchImpl: async (_url, init) => {
      if (!init.signal) throw new Error('missing gateway signal');
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(init.signal?.reason);
        }, { once: true });
        controller.abort(new Error('gateway deadline'));
      });
    } });
    expect(observedAbort).toBe(true);
    expect((await response.json()).result.isError).toBe(true);
  });

  test('cancellation during retry backoff prevents a second provider attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const google = createGoogleClient({ token: TOKEN, signal: controller.signal,
      fetchImpl: async () => { calls++; return new Response('', { status: 503 }); },
      sleep: async () => { controller.abort(new Error('gateway deadline')); },
    });
    await expect(google.json({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages' })).rejects.toThrow('gateway deadline');
    expect(calls).toBe(1);
  });
});
