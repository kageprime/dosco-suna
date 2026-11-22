const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  APP_PATH_PREFIXES,
  isAppPath,
  isApprovalDialogPath,
  isPreviewHost,
  isStripeHostedPage,
} = require('./nav-rules');

/**
 * The web middleware's `DESKTOP_ALLOWED_ROUTES`, read from source. The shell
 * and the web app run in different processes and share no module, so the only
 * link between the two lists is this test.
 */
function middlewareDesktopRoutes() {
  const middleware = readFileSync(join(__dirname, '../../web/src/middleware.ts'), 'utf8');
  const block = middleware.match(/const DESKTOP_ALLOWED_ROUTES = \[([\s\S]*?)\];/);
  if (!block) throw new Error('DESKTOP_ALLOWED_ROUTES not found in apps/web/src/middleware.ts');
  const code = block[1].replace(/\/\/.*$/gm, '');
  return [...code.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('desktop navigation gate', () => {
  test('allows exactly the routes the web middleware allows on desktop', () => {
    // A route the middleware allows but the shell does not opens in the system
    // browser on a full-page load, and the app window stays where it was. That
    // is how a redirect to /settings/billing left the window stuck on /auth.
    expect([...APP_PATH_PREFIXES].sort()).toEqual(middlewareDesktopRoutes().sort());
  });

  test('keeps full-page loads to allowed routes in the app window', () => {
    expect(isAppPath('/settings/billing')).toBe(true);
    expect(isAppPath('/workspaces/p1/sessions/s1')).toBe(true);
    // A pre-2026-11-06 link: in the window, where next.config redirects it.
    expect(isAppPath('/projects/p1/sessions/s1')).toBe(true);
    expect(isAppPath('/new')).toBe(true);
    expect(isAppPath('/auth')).toBe(true);
    expect(isAppPath('/auth/callback')).toBe(true);
  });

  test('keeps the site root in the app window', () => {
    // `window.location.href = '/'` (account deletion) must not open the system
    // browser. On desktop the middleware sends `/` to the landing door.
    expect(isAppPath('/')).toBe(true);
  });

  test('sends everything else to the system browser', () => {
    expect(isAppPath('/pricing')).toBe(false);
    expect(isAppPath('/docs')).toBe(false);
    // Prefix match is by segment: `/newsroom` is not `/new`.
    expect(isAppPath('/newsroom')).toBe(false);
    // Removed routes the shell used to list.
    expect(isAppPath('/templates')).toBe(false);
    expect(isAppPath('/accounts')).toBe(false);
  });

  test('treats sandbox previews and tunnels as in-app hosts', () => {
    expect(isPreviewHost('abc.kortix.cloud')).toBe(true);
    expect(isPreviewHost('kortix.cloud')).toBe(true);
    expect(isPreviewHost('p1.localhost')).toBe(true);
    expect(isPreviewHost('evilkortix.cloud')).toBe(false);
    expect(isPreviewHost('github.com')).toBe(false);
  });
});

describe('isStripeHostedPage', () => {
  const stays = (url) => isStripeHostedPage(new URL(url));

  test('keeps Stripe Checkout and the billing portal in the app window', () => {
    // Subscribe and Manage billing leave the app for these pages. In the window,
    // their success, cancel and return URLs come back to it; in the system
    // browser the window kept its spinner and never saw the return.
    expect(stays('https://checkout.stripe.com/c/pay/cs_test_synthetic#fid')).toBe(true);
    expect(stays('https://billing.stripe.com/p/session/test_synthetic')).toBe(true);
    // Kortix's own Stripe domain, a CNAME to Stripe's hosted checkout.
    expect(stays('https://pay.kortix.com/c/pay/cs_live_synthetic')).toBe(true);
    expect(stays('https://pay.kortix.com/p/session/live_synthetic')).toBe(true);
  });

  test('sends other Stripe hosts and lookalikes to the system browser', () => {
    expect(stays('https://stripe.com/pricing')).toBe(false);
    expect(stays('https://dashboard.stripe.com/payments')).toBe(false);
    expect(stays('https://connect.stripe.com/oauth/authorize')).toBe(false);
    expect(stays('https://checkout.stripe.com.example.test/c/pay/x')).toBe(false);
    expect(stays('https://evilcheckout.stripe.com/c/pay/x')).toBe(false);
    expect(stays('https://checkout-stripe.com/c/pay/x')).toBe(false);
    expect(stays('https://pay.kortix.com.example.test/c/pay/x')).toBe(false);
    expect(stays('https://kortix.com/pricing')).toBe(false);
  });

  test('requires https on the default port', () => {
    expect(stays('http://checkout.stripe.com/c/pay/x')).toBe(false);
    expect(stays('https://checkout.stripe.com:8443/c/pay/x')).toBe(false);
  });
});

describe('isApprovalDialogPath', () => {
  test('keeps the device approval and its sign-in inside the dialog', () => {
    expect(isApprovalDialogPath('/tunnel/authorize/ABCD-1234')).toBe(true);
    expect(isApprovalDialogPath('/auth')).toBe(true);
    expect(isApprovalDialogPath('/auth/callback')).toBe(true);
  });

  test('treats every other app page as leaving the dialog', () => {
    // Back replaces the page with the app home: that must close the dialog,
    // not render the app inside it.
    expect(isApprovalDialogPath('/workspaces/p1')).toBe(false);
    expect(isApprovalDialogPath('/workspaces/start')).toBe(false);
    expect(isApprovalDialogPath('/')).toBe(false);
    expect(isApprovalDialogPath('/tunnelx')).toBe(false);
  });
});
