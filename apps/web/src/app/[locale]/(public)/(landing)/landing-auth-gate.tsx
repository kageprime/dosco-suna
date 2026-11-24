'use client';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { useAuth } from '@/features/providers/auth-provider';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import {
  LANDING_HOLD_ATTRIBUTE,
  LANDING_HOLD_CSS,
} from '@/lib/auth/landing-hold';
import { latestProjectPath } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The landing route's signed-in guard: a signed-in visitor never sees the
 * marketing home — the moment the auth provider resolves, they are in the app.
 *
 * Why this exists next to the middleware fast path (`middleware.ts`:
 * `pathname === '/' && user` redirects into a workspace). That fast path runs
 * only when the middleware may resolve the identity. For a session cookie that
 * is expired or inside the refresh margin it must not create an auth client —
 * a middleware-side refresh rotates the single-use refresh token on a response
 * surface whose Set-Cookie can be dropped (KRTX-2111) — so that request falls
 * through to the statically prerendered landing. The browser client then
 * refreshes the session legally, the navbar flips to signed-in, and without
 * this gate nothing navigates: the visitor stays on the marketing home
 * indefinitely (the founder-reported state on dev.kortix.com).
 *
 * The gate is the mirror of `useSignedOutRedirect` (the app's signed-out
 * guard), for the one marketing surface whose job it is to disappear for a
 * signed-in visitor. Deep marketing pages keep working: a visitor who chose
 * them (a pricing link, a blog post) is reading them on purpose.
 *
 * The paint hold itself lives in the root layout's head
 * (`lib/auth/landing-hold.ts`): a plain head script hides the document before
 * the prerendered landing paints, for a browser that holds a session cookie on
 * a landing root. This gate owns the decision:
 *
 * - Before the first client render paints, re-check with the exact cookie
 *   name and hold (also covers a client-side mount, where the head script's
 *   one run predates this route): a cookie holder swaps the landing for the
 *   same pending frame the destination shows (`ProjectPendingScreen`, as on
 *   `/auth`, `/workspaces/start` and the access boundary), so the ride into
 *   the app has no visual seam.
 * - When the provider resolves signed-in, `router.replace` moves into
 *   `latestProjectPath(user.id)` — the owner-validated last workspace, else
 *   the landing door. Never a query-param path, so no open redirect; and
 *   `replace` keeps the landing out of the history, so Back from the app
 *   never re-enters it.
 * - Signed out, the hold releases and the landing renders — its actual
 *   audience.
 */
export function LandingAuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  // SSR and the first client render show the landing: it matches the
  // prerendered HTML, so hydration never mismatches. The layout effect below
  // decides before that first client render paints.
  const [held, setHeld] = useState(false);
  const redirectedRef = useRef(false);

  useLayoutEffect(() => {
    const html = document.documentElement;
    if (!browserHoldsSessionCookie()) {
      html.removeAttribute(LANDING_HOLD_ATTRIBUTE);
      return;
    }
    html.setAttribute(LANDING_HOLD_ATTRIBUTE, '');
    setHeld(true);
    // Leaving the landing (into the app, or to any other page) must never
    // carry the hold with it: a held html would hide the next page.
    return () => html.removeAttribute(LANDING_HOLD_ATTRIBUTE);
  }, []);

  useEffect(() => {
    if (!held || isLoading || redirectedRef.current) return;
    if (!user) {
      // Signed out: the landing is the destination. Release the hold.
      document.documentElement.removeAttribute(LANDING_HOLD_ATTRIBUTE);
      setHeld(false);
      return;
    }
    redirectedRef.current = true;
    router.replace(latestProjectPath(user.id));
  }, [held, isLoading, user, router]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LANDING_HOLD_CSS }} />
      {/* Without JS the hold can never be decided: show the landing. */}
      <noscript>
        <style
          dangerouslySetInnerHTML={{ __html: `html[${LANDING_HOLD_ATTRIBUTE}]{visibility:visible}` }}
        />
      </noscript>
      {held ? (
        // The hold CSS keeps the rest of the document invisible; re-enable
        // visibility for the pending frame alone, so no marketing chrome
        // shows behind it and the destination renders no seam.
        <div style={{ visibility: 'visible' }}>
          <ProjectPendingScreen />
        </div>
      ) : (
        children
      )}
    </>
  );
}

/** The exact check: the session cookie (or one of its chunks) is present. */
function browserHoldsSessionCookie(): boolean {
  return document.cookie.split('; ').some((entry) => {
    if (!entry.startsWith(KORTIX_SUPABASE_AUTH_COOKIE)) return false;
    const rest = entry.slice(KORTIX_SUPABASE_AUTH_COOKIE.length);
    return rest.startsWith('=') || /^\.\d+=/.test(rest);
  });
}
