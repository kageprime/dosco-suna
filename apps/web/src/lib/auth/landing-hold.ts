/**
 * The landing route's paint hold for a visitor who might be signed in.
 *
 * The marketing home is statically prerendered (KRTX-3255), so its HTML can
 * paint before React runs. The middleware fast path (`pathname === '/' &&
 * user`) redirects the requests whose identity it may resolve; for a session
 * cookie that is expired or inside the refresh margin it must not create an
 * auth client (KRTX-2111), and that request gets the static landing. The
 * browser then refreshes the session — and the landing route's
 * `LandingAuthGate` navigates into the app the moment the provider resolves.
 *
 * Between HTML and that resolution, the hold keeps the landing invisible for
 * a cookie holder, so a signed-in visitor never sees it — not even for a
 * frame. It is a visibility flip on `<html>`, decided by cookie presence
 * alone; it grants nothing and decides nothing. Signed-out visitors never see
 * it: no cookie, no attribute, no delay.
 */

import { locales } from '@/i18n/catalog.mjs';

/** Set on `<html>` while the landing is held. Never set for a signed-out visitor. */
export const LANDING_HOLD_ATTRIBUTE = 'data-kx-landing-hold';

/**
 * The Supabase session cookie, by name family: `sb-kortix-auth-token` with an
 * optional port suffix (local dev) and chunk suffixes (`.0`, `.1`, …). Only a
 * paint decision — the gate checks the exact `KORTIX_SUPABASE_AUTH_COOKIE`.
 */
export const LANDING_HOLD_COOKIE_PATTERN = /(?:^|;\s*)sb-kortix-auth-token[^=;]*=/;

/** The landing roots: `/` and every locale root (`/en`, `/de`, …), trailing slash allowed. */
const LANDING_ROOT_PATTERN = `^/(?:${locales.join('|')})?/?$`;

/** CSS that hides the document while the hold attribute is set. */
export const LANDING_HOLD_CSS = `html[${LANDING_HOLD_ATTRIBUTE}]{visibility:hidden}`;

/**
 * The pre-React paint hold, rendered once per document in the root layout's
 * head (a plain script there never re-runs and never warns). It runs before
 * the landing paints: a browser holding a session cookie on a landing root
 * gets an invisible document until the gate decides.
 */
export const LANDING_HOLD_SCRIPT = `(function(){try{if(new RegExp("${LANDING_ROOT_PATTERN}").test(location.pathname)&&/${LANDING_HOLD_COOKIE_PATTERN.source}/.test(document.cookie))document.documentElement.setAttribute("${LANDING_HOLD_ATTRIBUTE}","")}catch(e){}})();`;
