/**
 * Where an emailed auth link may send the browser back to.
 *
 * The link must return to the ORIGIN THAT HOLDS THE PKCE VERIFIER — the
 * browser that asked for the email. The verifier lives in that origin's
 * cookie jar (host-scoped) and its resume snapshot in that origin's
 * sessionStorage, so a link that leaves the browsing origin loses both: the
 * /auth/callback exchange throws `pkce_code_verifier_not_found` and a
 * seconds-old signup confirmation dies on the "The link is invalid or
 * expired." screen (KRTX-4628: the customer browses the apex host while the
 * configured APP_URL names the www host — every signup link targeted www,
 * where the jar was empty; the same profile's SECOND sign-in only worked
 * because the failed flow had already moved the browser onto www).
 *
 * When the request origin and the configured origin are the same site (the
 * hosts differ by nothing or only by the `www.` prefix), the request origin
 * wins — it IS the browser that started the flow. For anything else the
 * configured APP_URL stands (preview environments, where the request origin
 * is a throwaway deployment URL the Supabase project may not allowlist).
 * Supabase's redirect-URL allowlist stays the authority on where the link may
 * land at all: a forged origin value cannot widen the surface, it can only
 * make GoTrue fall back to the site URL.
 */

function hostWithoutWww(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

function sameSiteHosts(a: string, b: string): boolean {
  return hostWithoutWww(a) === hostWithoutWww(b);
}

function isHttpOrigin(origin: string): boolean {
  try {
    const protocol = new URL(origin).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveEmailLinkOrigin(requestOrigin?: string | null, configuredOrigin?: string | null): string {
  // A configured value that is not an http(s) origin (an undecrypted dotenvx
  // ciphertext reaching a build that ran plain `next build` — the caller
  // normalizes this, but never trust it twice at a trust boundary) cannot
  // name a link target: treat it as absent.
  const configured = configuredOrigin && isHttpOrigin(configuredOrigin) ? configuredOrigin : null;
  if (requestOrigin && configured && sameSiteHosts(requestOrigin, configured)) {
    return requestOrigin;
  }
  return configured || requestOrigin || 'http://localhost:3000';
}
