/**
 * Origin the /blog rewrites in next.config.ts proxy to.
 * Unset by default so /blog never proxies back to the main site origin
 * (which causes a 508 Loop Detected when proxying https://dosco.live to itself).
 * Set KORTIX_BLOG_ORIGIN explicitly to a distinct blog host if a standalone
 * blog deployment is attached.
 */
const DEFAULT_BLOG_ORIGIN: string | undefined = undefined;
const SELF_BLOG_ORIGINS = new Set(['https://dosco.live', 'http://dosco.live', 'https://www.dosco.live', 'http://www.dosco.live']);

function resolveBlogOrigin(origin: string | undefined): string | undefined {
  const candidate = (origin ?? DEFAULT_BLOG_ORIGIN)?.replace(/\/+$/, '');
  if (!candidate || SELF_BLOG_ORIGINS.has(candidate.toLowerCase())) {
    return undefined;
  }
  return candidate;
}

export const BLOG_ORIGIN = resolveBlogOrigin(process.env.KORTIX_BLOG_ORIGIN);
