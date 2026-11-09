import { HTTPException } from 'hono/http-exception';
import type { ProxyServiceConfig } from '../../config/proxy-services';

/**
 * The upstream budget of one managed Firecrawl request (Kortix's key).
 *
 * The proxy bills every Firecrawl POST as one flat tool request. Firecrawl
 * bills per page: one credit per web page, one more per parsed PDF page, and
 * add-ons (LLM formats, browser actions, prompt-injection checks, PII
 * redaction, threat scans) add credits per page. So the request is bounded
 * before it leaves, and the flat charge covers a known maximum:
 *
 * - at most FIRECRAWL_MAX_PAGES pages: `limit` on crawl and search;
 * - at most FIRECRAWL_MAX_PAGES parsed PDF pages, shared by the request's
 *   pages (v2 `parsers: [{ type: 'pdf', maxPages }]`). v1 has no page cap, so
 *   a v1 request does not parse PDFs (`parsePDF: false`);
 * - scrape options only from an allow-list of options that add no credit.
 *   Any other option answers 400 before the credit reservation.
 *
 * A caller that needs more uses its own Firecrawl key (passthrough mode).
 */
export const FIRECRAWL_MAX_PAGES = 100;

const PLAIN_FORMATS = new Set(['markdown', 'html', 'rawHtml', 'links', 'images', 'screenshot', 'screenshot@fullPage']);

const PLAIN_OPTIONS = new Set([
  'url', 'origin', 'integration',
  'formats', 'onlyMainContent', 'includeTags', 'excludeTags', 'maxAge', 'minAge', 'headers', 'waitFor',
  'mobile', 'skipTlsVerification', 'timeout', 'parsers', 'parsePDF', 'location', 'removeBase64Images',
  'blockAds', 'proxy', 'storeInCache', 'fastMode',
]);

const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

function refuse(option: string): never {
  throw new HTTPException(400, {
    message: `Firecrawl option "${option}" is not available through the Kortix proxy: it adds credits per page. Use your own Firecrawl key for it.`,
  });
}

function boundScrapeOptions(options: Record<string, any>, version: string, pdfPages: number): void {
  for (const key of Object.keys(options)) if (!PLAIN_OPTIONS.has(key)) refuse(key);
  for (const format of Array.isArray(options.formats) ? options.formats : []) {
    const type = typeof format === 'string' ? format : format?.type;
    if (!PLAIN_FORMATS.has(type)) refuse(`formats: ${String(type)}`);
  }
  if (version === 'v1') {
    options.parsePDF = false;
    return;
  }
  const parsers: unknown[] = Array.isArray(options.parsers) ? options.parsers : ['pdf', 'image'];
  options.parsers = parsers.map((parser: any) => {
    if (parser !== 'pdf' && parser?.type !== 'pdf') return parser;
    const own = typeof parser === 'object' ? parser : {};
    return { ...own, type: 'pdf', maxPages: Math.min(positive(own.maxPages) ?? pdfPages, pdfPages) };
  });
}

/** Bound a managed Firecrawl `POST …/{scrape,crawl,search}` body; any other request is returned as is. */
export function boundFirecrawlRequest(
  service: ProxyServiceConfig,
  method: string,
  subPath: string,
  body: ArrayBuffer | string | undefined,
  headers: Headers,
): ArrayBuffer | string | undefined {
  if (service.name !== 'firecrawl' || method.toUpperCase() !== 'POST' || !body) return body;
  const route = /^\/(v[12])\/(scrape|crawl|search)\/?$/.exec(subPath.split('?')[0]!);
  if (!route) return body;
  const [, version, kind] = route as unknown as [string, string, string];
  let json: Record<string, any>;
  try {
    json = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
  } catch {
    return body; // no JSON body: the upstream rejects it
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return body;

  if (kind === 'scrape') {
    boundScrapeOptions(json, version, FIRECRAWL_MAX_PAGES);
  } else {
    // Crawl's upstream default is 10,000 pages, so a crawl always gets a limit.
    // Search's default is 5 results.
    if (kind === 'crawl' || json.limit !== undefined) {
      json.limit = Math.min(positive(json.limit) ?? FIRECRAWL_MAX_PAGES, FIRECRAWL_MAX_PAGES);
    }
    const pages = json.limit ?? 5;
    // A crawl scrapes every page even without scrapeOptions; a search only with them.
    if (kind === 'crawl' || json.scrapeOptions != null) {
      const options = json.scrapeOptions && typeof json.scrapeOptions === 'object' ? json.scrapeOptions : {};
      boundScrapeOptions(options, version, Math.max(1, Math.floor(FIRECRAWL_MAX_PAGES / pages)));
      json.scrapeOptions = options;
    }
  }

  const next = JSON.stringify(json);
  headers.set('Content-Length', new TextEncoder().encode(next).length.toString());
  return next;
}
