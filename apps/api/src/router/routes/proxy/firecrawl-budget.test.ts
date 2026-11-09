import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProxyServiceConfig } from '../../config/proxy-services';

/**
 * A managed Firecrawl request (Kortix's key) is billed as one flat tool
 * request, so its upstream page count is bounded before it leaves: crawl and
 * search `limit`, parsed PDF pages, and no per-page paid add-on.
 */

let reserveCalls = 0;
let upstream: Array<{ url: string; body: any }> = [];
let currentBody = '';

mock.module('./helpers', () => ({
  tryAuthenticate: async () => ({ isKortixUser: true, accountId: 'acct-synthetic' }),
  buildForwardHeaders: () => new Headers(),
  getRequestBody: async () => currentBody,
  matchAllowedRoute: () => ({ path: '/v2/scrape', methods: ['POST'] }),
  reserveToolProxyCredits: async () => {
    reserveCalls += 1;
    return null;
  },
  refundToolReservation: async () => undefined,
  injectApiKey: (_service: unknown, _headers: Headers, body: unknown) => body,
}));

const { handleProxy } = await import('./handlers');
const { FIRECRAWL_MAX_PAGES, boundFirecrawlRequest } = await import('./firecrawl-budget');
const { getToolCost } = await import('../../../config');
const { getProxyServices, matchAllowedRoute } = await import('../../config/proxy-services');

const originalFetch = globalThis.fetch;
const firecrawl = {
  name: 'firecrawl',
  targetBaseUrl: 'https://api.firecrawl.dev',
  getKortixApiKey: () => 'firecrawl-key',
  keyInjection: { type: 'header' as const, headerName: 'Authorization', prefix: 'Bearer ' },
  allowedRoutes: [],
  billingToolName: 'proxy_firecrawl',
} as ProxyServiceConfig;

async function scrape(body: unknown): Promise<number> {
  currentBody = JSON.stringify(body);
  const c = {
    req: {
      url: 'https://api.kortix.test/v1/router/firecrawl/v2/scrape',
      method: 'POST',
      header: () => undefined,
      raw: { clone: () => ({ text: async () => currentBody }) },
    },
  };
  try {
    return (await handleProxy(c, firecrawl, 'firecrawl')).status;
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
}

const bound = (subPath: string, body: unknown) =>
  JSON.parse(boundFirecrawlRequest(firecrawl, 'POST', subPath, JSON.stringify(body), new Headers()) as string);

beforeEach(() => {
  reserveCalls = 0;
  upstream = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    upstream.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('managed Firecrawl proxy: one flat charge, a bounded upstream request', () => {
  test('a PDF scrape reaches Firecrawl with at most FIRECRAWL_MAX_PAGES parsed PDF pages', async () => {
    expect(await scrape({ url: 'https://93.184.216.34/doc-500p.pdf', formats: ['markdown'] })).toBe(200);
    expect(reserveCalls).toBe(1);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(upstream[0]!.body).toEqual({
      url: 'https://93.184.216.34/doc-500p.pdf',
      formats: ['markdown'],
      parsers: [{ type: 'pdf', maxPages: FIRECRAWL_MAX_PAGES }, 'image'],
    });
  });

  test('a per-page paid add-on answers 400 before the credit reservation and the upstream hop', async () => {
    for (const body of [
      { url: 'https://93.184.216.34/', formats: [{ type: 'json', prompt: 'x' }] },
      { url: 'https://93.184.216.34/', formats: ['markdown', 'audio'] },
      { url: 'https://93.184.216.34/', actions: [{ type: 'wait', milliseconds: 1 }] },
      { url: 'https://93.184.216.34/', checkPromptInjection: true },
      { url: 'https://93.184.216.34/', redactPII: true },
    ]) {
      expect(await scrape(body)).toBe(400);
    }
    expect(reserveCalls).toBe(0);
    expect(upstream).toEqual([]);
  });
});

describe('boundFirecrawlRequest', () => {
  test('scrape: a larger PDF maxPages is clamped; a smaller one and other parser options stay', () => {
    expect(bound('/v2/scrape', { url: 'u', parsers: [{ type: 'pdf', mode: 'ocr', maxPages: 500 }] }).parsers).toEqual([
      { type: 'pdf', mode: 'ocr', maxPages: 100 },
    ]);
    expect(bound('/v2/scrape', { url: 'u', parsers: ['pdf'] }).parsers).toEqual([{ type: 'pdf', maxPages: 100 }]);
    expect(bound('/v2/scrape', { url: 'u', parsers: [{ type: 'pdf', maxPages: 7 }] }).parsers).toEqual([
      { type: 'pdf', maxPages: 7 },
    ]);
    expect(bound('/v2/scrape', { url: 'u', parsers: [] }).parsers).toEqual([]);
  });

  test('v1 has no PDF page cap, so a v1 scrape or crawl does not parse PDFs', () => {
    expect(bound('/v1/scrape', { url: 'u' })).toEqual({ url: 'u', parsePDF: false });
    expect(bound('/v1/crawl', { url: 'u' }).scrapeOptions).toEqual({ parsePDF: false });
  });

  test('crawl: limit is clamped to the page budget, and the pages share the PDF budget', () => {
    const big = bound('/v2/crawl', { url: 'u', limit: 10_000 });
    expect(big.limit).toBe(100);
    expect(big.scrapeOptions.parsers).toEqual([{ type: 'pdf', maxPages: 1 }, 'image']);
    const small = bound('/v2/crawl', { url: 'u', limit: 4, scrapeOptions: { formats: ['markdown'] } });
    expect(small.limit).toBe(4);
    expect(small.scrapeOptions).toEqual({ formats: ['markdown'], parsers: [{ type: 'pdf', maxPages: 25 }, 'image'] });
    expect(bound('/v1/crawl', { url: 'u' }).limit).toBe(100);
  });

  test('search: limit is clamped; results are scraped only with scrapeOptions, inside the budget', () => {
    expect(bound('/v2/search', { query: 'q' })).toEqual({ query: 'q' });
    expect(bound('/v2/search', { query: 'q', limit: 1000 }).limit).toBe(100);
    expect(bound('/v2/search', { query: 'q', limit: 10, scrapeOptions: { formats: ['markdown'] } }).scrapeOptions).toEqual({
      formats: ['markdown'],
      parsers: [{ type: 'pdf', maxPages: 10 }, 'image'],
    });
  });

  test('a paid add-on nested in crawl or search scrapeOptions is refused', () => {
    expect(() => bound('/v2/crawl', { url: 'u', scrapeOptions: { formats: ['summary'] } })).toThrow(/summary/);
    expect(() => bound('/v1/search', { query: 'q', scrapeOptions: { jsonOptions: {} } })).toThrow(/jsonOptions/);
    expect(() => bound('/v2/crawl', { url: 'u', scrapeOptions: { threatProtection: { mode: 'normal' } } })).toThrow(
      /threatProtection/,
    );
  });

  test('map, a status poll, a non-JSON body and another service pass through unchanged', () => {
    const body = JSON.stringify({ url: 'u', limit: 10_000 });
    expect(boundFirecrawlRequest(firecrawl, 'POST', '/v2/map', body, new Headers())).toBe(body);
    expect(boundFirecrawlRequest(firecrawl, 'GET', '/v2/crawl/abc', body, new Headers())).toBe(body);
    expect(boundFirecrawlRequest(firecrawl, 'POST', '/v2/scrape', 'not json', new Headers())).toBe('not json');
    const tavily = { ...firecrawl, name: 'tavily' } as ProxyServiceConfig;
    expect(boundFirecrawlRequest(tavily, 'POST', '/v2/crawl', body, new Headers())).toBe(body);
  });

  test('the rewritten body carries its own Content-Length', () => {
    const headers = new Headers();
    const out = boundFirecrawlRequest(firecrawl, 'POST', '/v2/crawl', JSON.stringify({ url: 'u' }), headers);
    expect(headers.get('content-length')).toBe(String(new TextEncoder().encode(out as string).length));
  });
});

describe('Firecrawl crawl billing routes', () => {
  const routes = getProxyServices().firecrawl!.allowedRoutes;

  test('starting a crawl is billed; a status poll is free', () => {
    const start = matchAllowedRoute('POST', '/v2/crawl', routes);
    const poll = matchAllowedRoute('GET', '/v2/crawl/abc123', routes);
    expect(getToolCost(start!.billingToolName ?? 'proxy_firecrawl')).toBeGreaterThan(0);
    expect(getToolCost(poll!.billingToolName ?? 'proxy_firecrawl')).toBe(0);
  });
});
