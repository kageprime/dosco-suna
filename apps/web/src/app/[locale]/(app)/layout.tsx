import { Suspense } from 'react';

import { DesktopQuickEntry } from '@/components/desktop/desktop-quick-entry';
import { AccountHubRouter } from '@/features/accounts/hub/account-hub-router';
import { BillingReturnWatcher } from '@/features/billing/billing-return';
import { ExtensionPanelIdentity } from '@/features/chrome/extension-panel-identity';
import { MfaGate } from '@/features/auth/mfa-step-up';
import { NotificationHost } from '@/features/notifications/notification-host';
import { ProjectSwitchWatcher } from '@/features/workspace/project-switch-watcher';

/**
 * Shell for every authenticated app route.
 *
 * Its only job is to host behaviour that must not depend on WHICH app route the
 * user happens to be on. Returning from Stripe is the first such case: the
 * handling used to live in the projects list page, which forced every checkout
 * `success_url` to point at `/workspaces` — the one surface that is deliberately
 * never a destination. Ending a workspace switch is the second: the picker that
 * starts one closes immediately, and the route it navigates to is a different
 * one on either side, so only a shell above both can watch it land.
 *
 * The account hub overlay is the third such case. It opens over whatever app
 * route you are on — a project, a session, the projects list — so only a
 * shell above all of them can mount it. It renders nothing until something
 * opens it, and it stands down entirely while an `/accounts/**` route is
 * showing the same surface. See `features/accounts/hub/account-hub-panel.tsx`.
 *
 * Keep this thin. Route-specific work belongs in the route.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* useSearchParams needs a Suspense boundary to avoid opting every route
          under (app) into client-side rendering at build time. */}
      <Suspense fallback={null}>
        <BillingReturnWatcher />
      </Suspense>
      <ProjectSwitchWatcher />
      {/* Web Push for this browser, new-notification toasts, and
          `?notification=<id>` read marks. Signed-in only (KRTX-1742). Mounted
          here, not in the root layout, so marketing and other public pages
          never show an app notification toast. */}
      <Suspense fallback={null}>
        <NotificationHost />
      </Suspense>
      <ExtensionPanelIdentity />
      {/* Desktop app only: starts a session from the Quick Entry bar the global
          shortcut opens over any app. */}
      <DesktopQuickEntry />
      {/* Draws nothing: it routes an account hub place (`?accountId=`, or a
          pane's `openAccountPanel`) to the matching Workspace settings
          section. */}
      <Suspense fallback={null}>
        <AccountHubRouter />
      </Suspense>
      {/* The app is gated on the TOTP step-up: an aal1 session with a verified
          second factor gets the code prompt instead of these routes until the
          session is aal2 (KRTX-1386). */}
      <MfaGate>{children}</MfaGate>
    </>
  );
}
