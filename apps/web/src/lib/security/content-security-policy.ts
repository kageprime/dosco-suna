/**
 * Content-Security-Policy for every web response (see `headers()` in
 * next.config.ts).
 *
 * One enforced `Content-Security-Policy` header: `frame-ancestors` (this
 * origin and the Kortix extension, whose side panel frames the app),
 * `object-src 'none'`, `base-uri 'self'`, the `script-src` allowlist and
 * `report-uri`. Every block lands in `/api/csp-report`, so a host that a page
 * needs but the allowlist misses shows in the Vercel logs as a `[csp-report]`
 * warning instead of failing silently.
 *
 * `script-src` was report-only for one release cycle so the reports could
 * prove the allowlist complete. A pentest (2026-10-22) pointed out the cost of
 * leaving it there: report-only blocks nothing, so a third-party script added
 * to a page — or a compromised tag manager — still executed. The list below is
 * the set of hosts the app actually loads scripts from today; `'unsafe-inline'`
 * is still required by the root layout's inline bootstrap, so this does not
 * yet protect against injected inline script, only against unlisted hosts.
 * Moving to nonces is the next step.
 *
 * The report-only copy of this policy was removed on 2026-11-12. It was
 * identical to the enforced one, so each block was reported twice. Add a
 * `Content-Security-Policy-Report-Only` header back only to trial a stricter
 * policy than the enforced one.
 *
 * `next dev` alone adds `'unsafe-eval'`: React rebuilds the call stacks of
 * development errors with eval(), and without it every page logs "eval() is
 * not supported" and the dev overlay counts an issue. A production build never
 * calls eval(). Every deployed web app is a production build
 * (`apps/web/Dockerfile` sets `NODE_ENV=production`), so the deployed header is
 * unchanged.
 */

import { KORTIX_EXTENSION_ID } from '@kortix/ui/internal/chrome/extension';

export const CSP_REPORT_PATH = '/api/csp-report';

/** Hosts that legitimately serve scripts to kortix pages today. */
export const SCRIPT_SRC_HOSTS = [
  // Google Tag Manager and the tags it loads (GA4, Ads).
  'https://www.googletagmanager.com',
  'https://*.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://www.googleadservices.com',
  'https://googleads.g.doubleclick.net',
  // Consent banner and Meta pixel, both loaded by GTM.
  'https://cdn-cookieyes.com',
  'https://connect.facebook.net',
  // Cal.com booking embed in the demo modal (features/contact/demo-qualifier-modal.tsx).
  'https://app.cal.com',
  // Embedded checkout (app/[locale]/(app)/checkout).
  'https://js.stripe.com',
  // Vercel Analytics / Speed Insights / toolbar.
  'https://va.vercel-scripts.com',
  'https://vercel.live',
] as const;

/** This origin and the Kortix extension's side panel. */
function frameAncestorsDirective(): string {
  return `frame-ancestors 'self' chrome-extension://${KORTIX_EXTENSION_ID}`;
}

/** The complete `script-src` value. */
function scriptSourceDirective(): string {
  const scriptSrc = [
    "'self'",
    // Inline bootstrap scripts in the root layout; see the file comment.
    "'unsafe-inline'",
    // Shiki's regex engine and the file viewers compile WebAssembly.
    "'wasm-unsafe-eval'",
    // React's development call stacks; see the file comment.
    ...(process.env.NODE_ENV === 'development' ? ["'unsafe-eval'"] : []),
    // Workers created from blob URLs (PDF and editor workers).
    'blob:',
    ...SCRIPT_SRC_HOSTS,
  ];
  return `script-src ${scriptSrc.join(' ')}`;
}

export function enforcedContentSecurityPolicy(): string {
  // The Kortix Chrome extension frames the app in its side panel. X-Frame-Options
  // cannot allowlist an origin, so the app sends no XFO and this directive is the only gate.
  return (
    [
      scriptSourceDirective(),
      frameAncestorsDirective(),
      "object-src 'none'",
      "base-uri 'self'",
      `report-uri ${CSP_REPORT_PATH}`,
    ].join('; ') + ';'
  );
}

/** Session embeds reuse authentication and allow only Kortix-owned same-site hosts. */
export function embedContentSecurityPolicy(): string {
  return (
    [
      "frame-ancestors 'self' https://kortix.com https://*.kortix.com",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ') + ';'
  );
}

/** A browser extension's own script: the page cannot change what it runs. */
const EXTENSION_SCHEMES = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
]);

/**
 * The fields worth logging from one violation report, reduced to origins and
 * paths. A report's `document-uri` is the full page URL, and on some pages its
 * query or path carries an email address or a capability token; the log keeps
 * only the page path's first segment.
 *
 * `source` names the script that caused the violation, which an `eval` report
 * needs: without it, a blocked `eval` cannot be traced to a library. A script
 * of this origin under `/_next/static/` keeps its path, line and column (a
 * content-hashed chunk); any other script keeps its origin only.
 *
 * Null for a report that is not a CSP report, and for a violation caused by a
 * browser extension.
 */
export function summarizeCspReport(body: unknown): {
  directive: string;
  blocked: string;
  page: string;
  source?: string;
} | null {
  const report =
    body && typeof body === 'object' && 'csp-report' in body
      ? (body as { 'csp-report': unknown })['csp-report']
      : null;
  if (!report || typeof report !== 'object') return null;
  const field = (name: string) => {
    const value = (report as Record<string, unknown>)[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };
  if (isExtensionUrl(field('source-file')) || isExtensionUrl(field('blocked-uri'))) return null;
  const directive = (field('effective-directive') || field('violated-directive')).split(' ')[0]!;
  const source = scriptSource(
    field('source-file'),
    field('document-uri'),
    field('line-number'),
    field('column-number'),
  );
  return {
    directive: directive.slice(0, 64),
    blocked: originOrKeyword(field('blocked-uri')),
    page: firstPathSegment(field('document-uri')),
    ...(source ? { source } : {}),
  };
}

function isExtensionUrl(value: string): boolean {
  try {
    return EXTENSION_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function scriptSource(file: string, page: string, line: string, column: string): string {
  if (!file) return '';
  let url: URL;
  try {
    url = new URL(file);
  } catch {
    return file.slice(0, 32);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
  let pageOrigin = '';
  try {
    pageOrigin = new URL(page).origin;
  } catch {
    pageOrigin = '';
  }
  if (url.origin !== pageOrigin || !url.pathname.startsWith('/_next/static/')) return url.origin;
  const position = /^\d+$/.test(line) ? `:${line}${/^\d+$/.test(column) ? `:${column}` : ''}` : '';
  return `${url.pathname.slice(0, 128)}${position}`;
}

function originOrKeyword(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
  } catch {
    // `inline`, `eval`, `wasm-eval`, `blob`, …
    return value.slice(0, 32);
  }
}

function firstPathSegment(value: string): string {
  try {
    const segment = new URL(value).pathname.split('/')[1] ?? '';
    return `/${segment.slice(0, 64)}`;
  } catch {
    return '';
  }
}
