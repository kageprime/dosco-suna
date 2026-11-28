import { extractReadableHtml } from '@kortix/shared/tools';
import type { ProxyServiceConfig } from '../../config/proxy-services';
import { readCapped } from '../../../channels/core/download';
import { config } from '../../../config';
import { logger } from '../../../lib/logger';
import { safeEgressFetch } from '../../../shared/ssrf-guard';

/**
 * The router's fallback for web search and page reading (KRTX-5162). It
 * serves a session's `tavily /search` and `firecrawl /v1|v2/scrape` when the
 * paid provider cannot: the Kortix key is unset, the provider refuses Kortix's
 * account (over quota, rate limit, refused key). A provider 5xx still passes
 * through (KRTX-2073). Unsetting `TAVILY_API_KEY` or
 * `FIRECRAWL_API_KEY` makes the fallback the only backend. The answer
 * keeps the provider's JSON shape, so the session tools do not change. A
 * fallback answer is not billed (the reservation is refunded or never made).
 *
 * - Search: Google results through Kortix's Serper key (`SERPER_API_KEY`,
 *   already funded for `image_search`; Serper lists $1 per 1,000 queries,
 *   Tavily $8 per 1,000 credits). `topic: 'news'` uses Serper's news search.
 *   At most 20 results. No images; an answer only from Serper's answer box.
 * - Scrape: one GET through `safeEgressFetch` (private and metadata addresses
 *   refused, every redirect checked again), at most 2 MB, readable text of
 *   the HTML. No JavaScript rendering and no PDF.
 *
 * ponytail: search still needs one paid provider; keyless engines
 * (DuckDuckGo) answer datacenter IPs with a bot challenge. The upgrade path
 * is a self-hosted SearXNG JSON endpoint as a second `search()` backend.
 */

const SEARCH_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 20_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; KortixFetch/1.0; +https://kortix.com)';

/** Google results through Kortix's Serper key in Tavily's shape, or null when the key is unset or Serper refuses. */
async function search(request: Record<string, unknown>): Promise<Response | null> {
  const query = String(request.query ?? '').trim();
  if (!query || !config.SERPER_API_KEY) return null;
  const max = Math.max(1, Math.min(Number(request.max_results) || 5, 20));
  const started = Date.now();
  const news = request.topic === 'news';
  const upstream = await fetch(`${config.SERPER_API_URL}/${news ? 'news' : 'search'}`, {
    method: 'POST',
    headers: { 'X-API-KEY': config.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: max }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!upstream.ok) return null;
  type Hit = { title?: string; link?: string; snippet?: string; date?: string };
  const data = (await upstream.json()) as { answerBox?: { answer?: string; snippet?: string }; organic?: Hit[]; news?: Hit[] };
  return Response.json({
    query,
    answer: data.answerBox?.answer ?? data.answerBox?.snippet ?? '',
    results: ((news ? data.news : data.organic) ?? []).slice(0, max).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      content: r.snippet ?? '',
      ...(r.date ? { published_date: r.date } : {}),
    })),
    images: [],
    response_time: (Date.now() - started) / 1000,
  });
}

/** The page's readable text in Firecrawl's scrape shape (a failure for an HTTP error page), or null for a non-text page or one over 2 MB. */
async function scrape(request: Record<string, unknown>): Promise<Response | null> {
  const url = String(request.url ?? '');
  if (!url) return null;
  const page = await safeEgressFetch(url, {
    allowHttp: true,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!page.ok) {
    await page.body?.cancel().catch(() => {});
    // An error page is no source: Firecrawl's failure shape, which scrape_webpage reports as a failed URL.
    // 424, not 5xx: the page failed, not Kortix, so it stays out of the API's 5xx error counts.
    return Response.json({ success: false, error: `The page answered HTTP ${page.status}` }, { status: 424 });
  }
  const contentType = page.headers.get('content-type') ?? '';
  if (contentType && !/^text\/|json|xml/i.test(contentType)) {
    await page.body?.cancel().catch(() => {});
    return null; // a PDF or an image: the provider's job
  }
  const bytes = await readCapped(page, PAGE_MAX_BYTES);
  if (!bytes) return null;
  const raw = new TextDecoder().decode(bytes);
  const { title, text: markdown } = /html/i.test(contentType) || raw.trimStart().startsWith('<')
    ? extractReadableHtml(raw)
    : { title: undefined, text: raw };
  const formats = Array.isArray(request.formats) ? request.formats : [];
  return Response.json({
    success: true,
    data: {
      markdown,
      ...(formats.includes('html') ? { html: raw } : {}),
      metadata: { title: title ?? '', sourceURL: url, statusCode: page.status, contentType },
    },
  });
}

/**
 * The fallback answer for a managed request, or null when the route has no
 * fallback or the fallback cannot serve it either.
 */
export async function serveWebFallback(
  service: ProxyServiceConfig,
  subPath: string,
  body: ArrayBuffer | string | undefined,
  reason: string,
): Promise<Response | null> {
  const fallback =
    service.name === 'tavily' && subPath === '/search'
      ? { backend: 'serper', serve: search }
      : service.name === 'firecrawl' && (subPath === '/v1/scrape' || subPath === '/v2/scrape')
        ? { backend: 'fetch', serve: scrape }
        : null;
  if (!fallback) return null;
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
  } catch {
    return null;
  }
  let response: Response | null = null;
  try {
    response = await fallback.serve(request);
  } catch (error) {
    logger.warn(`[PROXY] ${service.name} fallback ${fallback.backend} failed on ${subPath}: ${String(error).slice(0, 200).replace(/https?:\/\/\S+/g, '<url>')}`);
  }
  const backend = response ? fallback.backend : 'none';
  logger.info(`[PROXY] ${service.name} ${subPath} served by ${backend} (${reason})`, { backend, fallback_reason: reason });
  response?.headers.set('X-Kortix-Backend', backend);
  return response;
}
