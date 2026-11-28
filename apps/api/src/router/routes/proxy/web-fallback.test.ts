import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ProxyServiceConfig } from '../../config/proxy-services';
import { runWithContext } from '../../../lib/request-context';

// KRTX-5162: when Kortix's Tavily or Firecrawl account was over its limit, the
// router answered 503 `tool_unavailable` and every session lost web search and
// page reading. The router now serves those two routes with a fallback (search
// through Kortix's Serper key, scrape as a guarded fetch + readable text) in
// the provider's JSON shape, so the session tools see a normal answer.

let requestBody = '';
let authMode: 'kortix-key' | 'own-key' = 'kortix-key';
const refunds: string[] = [];
const fetched: string[] = [];

const config: Record<string, unknown> = { KORTIX_BILLING_INTERNAL_ENABLED: true, SERPER_API_URL: 'https://google.serper.dev' };
mock.module('../../../config', () => ({ config }));

mock.module('./helpers', () => ({
  tryAuthenticate: async () =>
    authMode === 'kortix-key'
      ? { isKortixUser: true, accountId: 'acct-synthetic' }
      : { isKortixUser: true, isPassthrough: true, accountId: 'acct-synthetic' },
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => requestBody,
  matchAllowedRoute: (_method: string, path: string) => ({ path, methods: ['POST'] }),
  reserveToolProxyCredits: async () => 'reservation-synthetic',
  refundToolReservation: async (_reservation: unknown, description: string) => {
    refunds.push(description);
  },
  injectApiKey: (_service: unknown, _headers: Headers, body: unknown) => body,
}));

mock.module('../../../lib/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// The synthetic page host does not resolve; the address checks are covered by
// the ssrf-guard tests. Here the guarded fetch is a plain fetch.
mock.module('../../../shared/ssrf-guard', () => ({
  assertSafeEgressUrl: async (url: string) => new URL(url),
  safeEgressFetch: (url: string, init: RequestInit) => fetch(url, init),
  UnsafeEgressError: class extends Error {},
}));

const { handleProxy } = await import('./handlers');

type SearchBody = {
  query: string;
  answer: string;
  images: unknown[];
  results: Array<{ title: string; url: string; content: string; published_date?: string }>;
  error?: string;
};
const originalFetch = globalThis.fetch;
type ScrapeBody = { success: boolean; data: { markdown: string; html?: string; metadata: Record<string, unknown> } };

const SERPER_RESULTS = JSON.stringify({
  answerBox: { answer: 'Under the desk.' },
  organic: [
    { title: 'Cable tray guide', link: 'https://guide.example/tray', snippet: 'Mount it under the desk.', date: 'Nov 2, 2026' },
    { title: 'Tray shop', link: 'https://shop.example/tray', snippet: 'Buy a tray.' },
  ],
});

const PAGE = `<!doctype html><html><head><title>Example Domain</title><style>body{color:red}</style></head>
<body><h1>Example Domain</h1><script>track()</script><p>This domain is for use in documentation examples.</p></body></html>`;

type Answer = { status: number; body: string; type?: string };
const PLAN_LIMIT: Answer = { status: 432, body: '{"detail":{"error":"This request exceeds your plan\'s set usage limit."}}' };
const SERPER_OK: Answer = { status: 200, body: SERPER_RESULTS };
const HTML_PAGE: Answer = { status: 200, body: PAGE, type: 'text/html; charset=utf-8' };

/** Upstream answers by host: the provider, Serper, or the page being read. Records each host and Serper's request. */
let serperRequest: { key: string | null; body: unknown } | null = null;
let serperUrl = '';
function network(provider: Answer, serper: Answer = SERPER_OK, page: Answer = HTML_PAGE) {
  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(new URL(url).host);
    const answer = url.startsWith('https://google.serper.dev/') ? serper : url.startsWith('https://page.example/') ? page : provider;
    if (answer === serper) {
      serperRequest = { key: new Headers(init?.headers).get('x-api-key'), body: JSON.parse(String(init?.body)) };
      serperUrl = url;
    }
    return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.type ?? 'application/json' } });
  };
  globalThis.fetch = Object.assign(upstream, { preconnect: originalFetch.preconnect });
}

function service(name: 'tavily' | 'firecrawl', key: string): ProxyServiceConfig {
  return {
    name,
    targetBaseUrl: name === 'tavily' ? 'https://api.tavily.com' : 'https://api.firecrawl.dev',
    getKortixApiKey: () => key,
    keyInjection: { type: 'header', headerName: 'Authorization' },
    allowedRoutes: [],
    billingToolName: `proxy_${name}`,
  };
}

function call(name: 'tavily' | 'firecrawl', path: string, body: Record<string, unknown>, key = 'kortix-managed-key') {
  requestBody = JSON.stringify(body);
  const url = `https://api.example/v1/router/${name}${path}`;
  const context = { req: { url, method: 'POST', header: () => undefined, raw: new Request(url, { method: 'POST', body: requestBody }) } };
  return runWithContext('POST', `/v1/router/${name}${path}`, () => handleProxy(context, service(name, key), name));
}

beforeEach(() => {
  authMode = 'kortix-key';
  config.SERPER_API_KEY = 'serper-managed-key';
  serperRequest = null;
  refunds.length = 0;
  fetched.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('web search fallback (KRTX-5162)', () => {
  test("search over Kortix's Tavily quota answers 200 from Serper in Tavily's shape, not billed", async () => {
    network(PLAN_LIMIT);

    const response = await call('tavily', '/search', { query: 'desk cable tray', max_results: 5 });
    const body = (await response.json()) as SearchBody;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-backend')).toBe('serper');
    expect(body.query).toBe('desk cable tray');
    expect(body.answer).toBe('Under the desk.');
    expect(body.images).toEqual([]);
    expect(body.results).toEqual([
      { title: 'Cable tray guide', url: 'https://guide.example/tray', content: 'Mount it under the desk.', published_date: 'Nov 2, 2026' },
      { title: 'Tray shop', url: 'https://shop.example/tray', content: 'Buy a tray.' },
    ]);
    expect(serperRequest).toEqual({ key: 'serper-managed-key', body: { q: 'desk cable tray', num: 5 } });
    expect(serperUrl).toBe('https://google.serper.dev/search');
    expect(fetched).toEqual(['api.tavily.com', 'google.serper.dev']);
    expect(refunds).toEqual(['Tool reservation refund after upstream error: tavily']);
  });

  test('search with no Tavily key goes straight to Serper and honours max_results', async () => {
    network(PLAN_LIMIT);

    const response = await call('tavily', '/search', { query: 'desk cable tray', max_results: 1 }, '');
    const body = (await response.json()) as SearchBody;

    expect(response.status).toBe(200);
    expect(body.results.map((r) => r.url)).toEqual(['https://guide.example/tray']);
    expect(fetched).toEqual(['google.serper.dev']);
  });

  test("topic 'news' asks Serper's news search and reads its news list", async () => {
    network(PLAN_LIMIT, { status: 200, body: JSON.stringify({ news: [{ title: 'Tray recall', link: 'https://news.example/recall', snippet: 'A recall.', date: '2 hours ago' }] }) });

    const response = await call('tavily', '/search', { query: 'cable tray recall', topic: 'news' });
    const body = (await response.json()) as SearchBody;

    expect(response.status).toBe(200);
    expect(serperUrl).toBe('https://google.serper.dev/news');
    expect(body.results).toEqual([{ title: 'Tray recall', url: 'https://news.example/recall', content: 'A recall.', published_date: '2 hours ago' }]);
  });

  test('when Serper refuses too, the answer stays 503 tool_unavailable', async () => {
    network(PLAN_LIMIT, { status: 403, body: '{"message":"Not enough credits"}' });

    const response = await call('tavily', '/search', { query: 'desk cable tray' });
    const body = (await response.json()) as SearchBody;

    expect(response.status).toBe(503);
    expect(body.error).toBe('tool_unavailable');
  });

  test('with no Serper key there is no search fallback: 503 tool_unavailable, Serper never called', async () => {
    delete config.SERPER_API_KEY;
    network(PLAN_LIMIT);

    const response = await call('tavily', '/search', { query: 'desk cable tray' });

    expect(response.status).toBe(503);
    expect(fetched).toEqual(['api.tavily.com']);
  });

  test("a provider 5xx is the provider's answer and passes through (KRTX-2073), not a fallback", async () => {
    network({ status: 502, body: 'bad gateway' });

    const response = await call('tavily', '/search', { query: 'desk cable tray' });

    expect(response.status).toBe(502);
    expect(fetched).toEqual(['api.tavily.com']);
  });

  test("a request error (400) is the provider's answer about the request, not a fallback", async () => {
    network({ status: 400, body: '{"detail":{"error":"Query is too long."}}' });

    const response = await call('tavily', '/search', { query: 'desk cable tray' });

    expect(response.status).toBe(400);
    expect(fetched).toEqual(['api.tavily.com']);
  });

  test("the caller's own key keeps the provider's answer: no fallback", async () => {
    authMode = 'own-key';
    network(PLAN_LIMIT);

    const response = await call('tavily', '/search', { query: 'desk cable tray' });

    expect(response.status).toBe(432);
    expect(fetched).toEqual(['api.tavily.com']);
  });
});

describe('page scrape fallback (KRTX-5162)', () => {
  test("scrape over Kortix's Firecrawl quota answers Firecrawl's v2 shape with the page's readable text", async () => {
    network(PLAN_LIMIT);

    const response = await call('firecrawl', '/v2/scrape', { url: 'https://page.example/', formats: ['markdown'] });
    const body = (await response.json()) as ScrapeBody;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-backend')).toBe('fetch');
    expect(body.success).toBe(true);
    expect(body.data.markdown).toBe('Example Domain\nThis domain is for use in documentation examples.');
    expect(body.data.html).toBeUndefined();
    expect(body.data.metadata).toMatchObject({ title: 'Example Domain', sourceURL: 'https://page.example/', statusCode: 200 });
    expect(fetched).toEqual(['api.firecrawl.dev', 'page.example']);
  });

  test('scrape with no Firecrawl key reads the page directly, and returns the HTML when asked', async () => {
    network(PLAN_LIMIT);

    const response = await call('firecrawl', '/v1/scrape', { url: 'https://page.example/', formats: ['markdown', 'html'] }, '');
    const body = (await response.json()) as ScrapeBody;

    expect(response.status).toBe(200);
    expect(body.data.html).toBe(PAGE);
    expect(fetched).toEqual(['page.example']);
  });

  test('a page that answers an HTTP error is a failed scrape, not a successful source', async () => {
    for (const status of [404, 500]) {
      network(PLAN_LIMIT, SERPER_OK, { status, body: '<html><title>Not found</title><p>Not found</p></html>', type: 'text/html' });

      const response = await call('firecrawl', '/v2/scrape', { url: 'https://page.example/missing' });
      const body = (await response.json()) as { success: boolean; error?: string };

      expect(response.status).toBe(424);
      expect(response.headers.get('x-kortix-backend')).toBe('fetch');
      expect(body).toEqual({ success: false, error: `The page answered HTTP ${status}` });
    }
  });

  test('a 2 MB page of & is read in linear time, so it cannot stall the API', async () => {
    network(PLAN_LIMIT, SERPER_OK, { status: 200, body: `<p>${'&'.repeat(2 * 1024 * 1024 - 8)}</p>`, type: 'text/html' });
    const started = performance.now();

    const response = await call('firecrawl', '/v2/scrape', { url: 'https://page.example/ampersands' });

    expect(response.status).toBe(200);
    // Rescanning the body for every & blocked the event loop ~29 s here.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a PDF is not read by the fallback: the provider's 503 stays", async () => {
    network(PLAN_LIMIT, SERPER_OK, { status: 200, body: '%PDF-1.7', type: 'application/pdf' });

    const response = await call('firecrawl', '/v2/scrape', { url: 'https://page.example/report.pdf' });

    expect(response.status).toBe(503);
  });

  test('a route with no fallback (Firecrawl crawl) keeps the 503', async () => {
    network(PLAN_LIMIT);

    const response = await call('firecrawl', '/v2/crawl', { url: 'https://page.example/' });

    expect(response.status).toBe(503);
    expect(fetched).toEqual(['api.firecrawl.dev']);
  });
});
