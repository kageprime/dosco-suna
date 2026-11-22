import { renderLoopmaxxingRobotsTxt } from '@/features/marketing/one-prompt/seo';
import { CANONICAL_ORIGIN } from '@kortix/ui/internal/lib/site-metadata';

const CANONICAL_HOSTS = new Set(['dosco.live', 'www.dosco.live']);

// Local dev serves the production robots policy so the local crawl-verification
// harness exercises exactly what dosco.live ships. An IPv6 host keeps its
// brackets: `[::1]:3000` has the hostname `[::1]`.
function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isCanonicalRobotsHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d*$/, '').toLowerCase();
  return CANONICAL_HOSTS.has(hostname) || isLocalHost(hostname);
}

// The production policy served on dosco.live (and localhost). Any other host —
// dev.dosco.live, staging.dosco.live, Vercel previews, self-hosted deployments
// — gets a blanket Disallow so non-canonical copies of the site never enter a
// search index alongside the canonical one.
const CANONICAL_ROBOTS = `# Dosco Robots.txt
User-agent: *
Allow: /
Allow: /api/ai
Content-Signal: ai-train=yes, search=yes, ai-input=yes

# Sitemap
Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml
Sitemap: ${CANONICAL_ORIGIN}/blog/sitemap.xml

# Disallow sensitive routes
Disallow: /api/
Disallow: /_next/

# Pages need their stylesheets, scripts and images to render. The longest
# matching rule wins, so these override \`Disallow: /_next/\`.
Allow: /_next/static/
Allow: /_next/image

# Machine-readable public content is intentionally crawlable.
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /markdown/
Allow: /.well-known/
Allow: /auth.md
Allow: /mcp
`;

const NON_CANONICAL_ROBOTS = `# Non-canonical deployment — the canonical site is ${CANONICAL_ORIGIN}
User-agent: *
Disallow: /
`;

/** The developer landing is its own canonical site, with its own sitemap. */
const LOOPMAXXING_HOSTS = new Set(['loopmaxxing.sh', 'www.loopmaxxing.sh']);

export function renderRobotsTxt(host: string | null): string {
  if (host && LOOPMAXXING_HOSTS.has(host.replace(/:\d*$/, '').toLowerCase())) return renderLoopmaxxingRobotsTxt();
  return isCanonicalRobotsHost(host) ? CANONICAL_ROBOTS : NON_CANONICAL_ROBOTS;
}
