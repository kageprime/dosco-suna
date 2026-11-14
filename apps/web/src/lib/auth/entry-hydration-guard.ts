/**
 * The /auth entry form's pre-hydration submit guard.
 *
 * The entry form's SSR HTML is typeable before React hydrates it. An Enter or
 * a Continue click inside that window (a cold visit spends seconds there on a
 * deployed env — chunk fetches at real-network latency) submits the form
 * natively: a full-page GET to /auth?email=… that discards what the visitor
 * typed, and React 19 additionally resets the field to its server-rendered
 * value the moment hydration lands, so early typing vanishes either way.
 *
 * This inline guard runs at parse time, before React exists. While it is
 * armed it prevents native submissions of the entry form, records the
 * intent in sessionStorage and stashes the typed address on every
 * keystroke, so nothing navigates and nothing typed is lost. React 19
 * attaches no reliably-timed props to DOM nodes, so the guard cannot tell
 * when hydration landed — instead the page itself disarms it: the auth
 * component's mount effect runs only once React is live, and it dispatches
 * `kortix:auth-hydrated` after restoring the stashed address and replaying
 * a recorded intent through the real submit handler. Until then every
 * guarded submit is prevented (a second Enter included); after it React's
 * own onSubmit drives the form unchanged.
 *
 * The inline script is CSP-clean (the enforced `script-src` allows
 * 'unsafe-inline' for the root layout's bootstrap scripts; see
 * lib/security/content-security-policy.ts), inert on every page without a
 * guarded form, and degrades to nothing when sessionStorage is unavailable.
 *
 * The root layout ships this script in `<head>`, beside the other parse-time
 * bootstrap scripts. It must not render inside the auth page: that page is a
 * client component, and React creates any `<script>` it renders on the
 * client without executing it, logging "Encountered a script tag while
 * rendering React component" on every load (audit F-001, 2026-11-12). The
 * listeners are document-level, so the guard covers the form whether it
 * arrives in the SSR HTML or after a client navigation.
 */

/** The submit intent the guard records when it prevents a native submit. */
export const ENTRY_SUBMIT_FLAG_KEY = 'kortix:auth-entry-submit';

/** The address the guard stashes as `{ t, v }` while the visitor types. */
export const ENTRY_EMAIL_STASH_KEY = 'kortix:auth-entry-email';

/** Ships in the root layout `<head>`; inert on every page without a guarded form. */
export const ENTRY_HYDRATION_GUARD_SCRIPT = `
(function () {
  if (window.__kortixAuthHydrationGuard) return;
  window.__kortixAuthHydrationGuard = true;
  var SUBMIT_KEY = '${ENTRY_SUBMIT_FLAG_KEY}';
  var EMAIL_KEY = '${ENTRY_EMAIL_STASH_KEY}';
  var armed = true;
  var isGuardedForm = function (node) {
    return !!(node && node.nodeType === 1 && node.matches && node.matches('form[data-hydrate-guard]'));
  };
  var stashEmail = function (event) {
    if (!armed) return;
    var input = event.target;
    if (!input || !input.matches || !input.matches('form[data-hydrate-guard] input[name="email"]')) return;
    try {
      // Timestamped: a stash left behind by a navigation must not refill the
      // field on a visit hours later. Same TTL as the submit intent.
      if (input.value) window.sessionStorage.setItem(EMAIL_KEY, JSON.stringify({ t: Date.now(), v: input.value }));
      else window.sessionStorage.removeItem(EMAIL_KEY);
    } catch (error) {}
  };
  var holdSubmit = function (event) {
    if (!armed) return;
    if (!isGuardedForm(event.target)) return;
    var recorded = false;
    try {
      window.sessionStorage.setItem(SUBMIT_KEY, String(Date.now()));
      recorded = true;
    } catch (error) {}
    if (!recorded) return; // sessionStorage unavailable: the intent cannot be handed over, so keep the pre-guard native behavior.
    // No React handler yet: a native GET here would reload /auth and discard
    // the typed address. Record the intent; the page replays it on mount.
    event.preventDefault();
  };
  document.addEventListener('submit', holdSubmit, true);
  document.addEventListener('input', stashEmail, true);
  window.addEventListener('kortix:auth-hydrated', function () {
    if (!armed) return;
    armed = false;
    document.removeEventListener('submit', holdSubmit, true);
    document.removeEventListener('input', stashEmail, true);
  }, { once: true });
})();
`;
