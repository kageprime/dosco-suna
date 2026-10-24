import { e2bDomain } from '../platform/providers/e2b-domain';

/**
 * E2B canonicalizes an app onto its own host family: a request answered at the
 * port-ingress host is bounced (308/302, sometimes a 303 after a login form) to
 * the bare sandbox host, or re-schemed. The redirect worked for nobody:
 *
 * - the BROWSER can't follow it, because the traffic token our proxy attaches
 *   as a header dies with the redirect (E2B's edge then 403s the follow-up —
 *   "e2b-traffic-access-token" pages, 2026-10-23);
 * - rewriting the Location to the public host instead tracked the App through
 *   apps with "canonicalize-everything" middleware: the rewritten target
 *   redirects again to the same provider host, the rewrite bounces it back to
 *   the public host, and the browser spins between the two until
 *   ERR_TOO_MANY_REDIRECTS (App-host incident, 2026-10-24).
 *
 * So the proxy follows provider-owned redirect hops server-side: the same
 * upstream fetch re-dials the hop target with the ingress credential headers
 * re-attached, never replaying anything but a GET/HEAD (a redirect after a
 * write is passed through untouched — the body must not be re-sent). The
 * result reaches the browser as one ordinary response; the browser never
 * leaves the Dosco host. Reads and non-provider redirects stay the caller's
 * business (self/external Locations pass through as before).
 */

/**
 * A redirect chain this deep is not a canonicalization bounce, it is two
 * hostile hosts answering each other. One more hop is refused with a 502
 * rather than announced as a redirect to the browser.
 */
export const MAX_PROVIDER_REDIRECT_HOPS = 3;

/**
 * Is `location`, resolved against `baseUrl`, a further hop inside the
 * provider's own ingress? Absolute `http(s)` and scheme-relative Locations
 * only: a plain relative Location never leaves the current origin, so the
 * caller's own handling of it is enough (and the browser resolves it without
 * losing anything). Returns the absolute target URL, or null.
 */
const E2B_CLOUD_DOMAINS = new Set(['e2b.app', 'e2b.dev', 'e2b.pro']);

export function providerIngressTarget(
  provider: string,
  location: string | null,
  baseUrl: string,
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) return null;
  if (provider !== 'e2b') return null;
  try {
    const target = new URL(location, baseUrl);
    const parent = new URL(baseUrl).hostname.split('.').slice(1).join('.');
    const ingressDomain = parent.includes('.') ? parent : '';
    const domains = new Set([ingressDomain, configuredE2bDomain()].filter(Boolean));
    // E2B Cloud redirects every browser navigation on `*.e2b.dev` (308) onto
    // `*.e2b.app`. When E2B_DOMAIN is `e2b.dev`, both `getHost()` (`baseUrl`)
    // and `E2B_DOMAIN` are `e2b.dev`, so without uniting E2B Cloud's sibling
    // domains (`supportedDomains` in the E2B SDK) the hop still escaped to the
    // browser (v67/v68, 2026-10-24). Self-hosted clusters stay isolated.
    if ([...domains].some((d) => E2B_CLOUD_DOMAINS.has(d))) {
      for (const cloud of E2B_CLOUD_DOMAINS) domains.add(cloud);
    }
    return [...domains].some((domain) => target.hostname.endsWith(`.${domain}`)) ? target.href : null;
  } catch {
    return null;
  }
}

/** E2B_DOMAIN, or '' when unset: an empty cluster leaves the ingress domain alone, not a 500. */
function configuredE2bDomain(): string {
  try {
    return e2bDomain();
  } catch {
    return '';
  }
}

/**
 * Re-dial provider-owned redirect hops until a non-redirect answer, a hop the
 * provider does not own, or the chain cap.
 *
 * - `first` is the already-received upstream response, `firstUrl` its URL.
 * - `hops` performs one fetch of `targetUrl` with the caller's own header
 *   building and attempt bounding; it is called only for followed hops.
 * - Options pin who may hop: `provider` must own the target, `method` must be
 *   GET or HEAD.
 *
 * Returns the final response, the original response untouched when nothing
 * needs following (including external Locations), or null when the chain
 * never settled inside the cap — the caller answers that with its own
 * `sandbox_redirect_loop` failure.
 */
export async function followProviderIngressRedirects(
  first: Response,
  firstUrl: string,
  hops: (targetUrl: string) => Promise<Response>,
  options: { provider: string; method: string },
): Promise<Response | null> {
  if (options.method !== 'GET' && options.method !== 'HEAD') return first;
  let upstream = first;
  let currentUrl = firstUrl;
  for (let hop = 0; upstream.status >= 300 && upstream.status < 400; hop++) {
    const target = providerIngressTarget(options.provider, upstream.headers.get('location'), currentUrl);
    if (!target) return upstream;
    if (hop >= MAX_PROVIDER_REDIRECT_HOPS) return null;
    // Draining the intermediate body keeps its connection from pinning a
    // stale socket until GC reads the provider sidestream out.
    await upstream.body?.cancel().catch(() => {});
    upstream = await hops(target);
    currentUrl = target;
  }
  return upstream;
}
