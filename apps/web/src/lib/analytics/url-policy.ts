/**
 * The URL policy both analytics pipelines share: which query parameters may
 * leave the browser, and which paths may not be tracked at all. `gtm.ts` (the
 * dataLayer) and `posthog-config.ts` (the PostHog scrubbers) both read this
 * module, so the answer is the same for GTM and PostHog.
 */

import { locales } from '@/i18n/catalog.mjs';

/**
 * Query parameters that may reach GTM. Everything else is dropped from
 * `page_location` and `page_referrer`: auth pages carry the user's email,
 * return URLs and handoff state in the query, and none of it is analytics.
 */
const ANALYTICS_QUERY_ALLOWLIST = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
]);

/** `origin + pathname`, plus only the allowlisted query parameters. Never a hash. */
export function analyticsLocation(origin: string, pathname: string, search?: string): string {
  const params = new URLSearchParams(search ?? '');
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (ANALYTICS_QUERY_ALLOWLIST.has(key)) kept.append(key, value);
  }
  const query = kept.toString();
  return `${origin}${pathname}${query ? `?${query}` : ''}`;
}

/**
 * Pages where no third-party analytics script may load: signed-in app
 * surfaces and pages whose URL carries a capability token. Checked on the
 * path without its locale prefix.
 */
const ANALYTICS_EXCLUDED_PREFIXES = [
  '/workspaces',
  '/admin',
  '/settings',
  '/connections',
  '/invites',
  '/setup',
  '/workspaces/new',
  '/secret-intake',
  '/connect',
  '/approve',
  '/share',
  '/slack',
  '/teams',
  '/tunnel',
  '/cli',
  '/oauth',
  '/preview',
  '/github',
];

export function isAnalyticsExcludedPath(pathname: string): boolean {
  const segments = pathname.split('/');
  const withoutLocale =
    segments.length > 1 && (locales as readonly string[]).includes(segments[1]!)
      ? `/${segments.slice(2).join('/')}`
      : pathname;
  return ANALYTICS_EXCLUDED_PREFIXES.some(
    (prefix) => withoutLocale === prefix || withoutLocale.startsWith(`${prefix}/`),
  );
}
