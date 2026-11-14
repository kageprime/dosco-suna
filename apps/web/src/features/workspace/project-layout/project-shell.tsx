'use client';

import { CommandPaletteBoundary } from '@/features/workspace/command-palette-boundary';
import { DriveUploadTray } from '@kortix/ui/files';
import { VoiceCallCard } from '@kortix/ui/session/voice/voice-call-card';
import { AppPreviewPoolLoader, usePreviewPoolProject } from '@/features/apps/app-preview-pool-loader';
import { ArtifactFramePreloader } from '@/features/artifacts/artifact-frame-preloader';
import { previewPoolAllowed } from './preview-pool-route';
import { useTranslations } from '@/i18n/use-translations';
import { useQuery } from '@tanstack/react-query';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { TITLEBAR_CONTROL_CLASS } from '@kortix/ui/internal/desktop/titlebar-control';
import { PersonalOnboardingWelcome } from '@/components/projects/personal-onboarding-welcome';
import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import {
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SidebarEdgePeek,
  useSidebar,
} from '@kortix/ui/sidebar';
import { useBrandingScope } from '@kortix/ui/internal/branding/branding-provider';
import { AppProviders } from '@/features/layout/app-providers';
import { useAuth } from '@/features/providers/auth-provider';
import { useCustomizePrefetch } from '@kortix/ui/customize/shared/use-customize-prefetch';
import { parseSidebarStateCookie } from '@kortix/ui/workspace/layout/sidebar-cookie';
import { useDesktopShell } from '@kortix/ui/internal/layout/sidebar-opener';
import { openCommandPalette } from '@kortix/ui/internal/layout/open-command-palette';
import { ProjectSidebar } from '@kortix/ui/workspace';
import { WorkspaceSwitcher } from '@/features/workspace/project-sidebar/workspace-switcher';
import { DownloadModal } from '@/features/marketing/download/download-modal';
import { SettingsPanel } from '@/features/workspace/settings/settings-panel';
import {
  isAccountGraduatedSection,
  legacySectionRedirect,
} from '@kortix/ui/customize/settings/settings-tabs';
import { useSettingsAccountId } from '@/features/workspace/settings/use-settings-account-id';
import { useNewProjectSession } from '@kortix/ui/internal/hooks/projects/use-new-project-session';
import { useProjectShellShortcuts } from '@/hooks/projects/use-project-shell-shortcuts';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { writeLastProjectId } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { cn, uiRoutes } from '@kortix/ui';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { isBillingEnabled } from '@/lib/config';
import { ConnectModelStep } from '@kortix/ui/session/models/connect-model-step';
import { useWorkspaceModelGate } from '@kortix/ui/session/models/use-workspace-model-gate';
import { getProject, getProjectDetail } from '@kortix/sdk';
import {
  contract,
  qk,
  useFeatureFlag,
  useGatewayCatalogSync,
} from '@kortix/sdk/react';
import { SidebarGlyph as PanelLeft } from '@kortix/ui/icons';
import {
  DesktopTabStrip,
  useDesktopTabsVisible,
} from '@/features/desktop-tabs/desktop-tab-strip';
import {
  DesktopTabsBoundary,
  useDesktopTabsEnabled,
} from '@/features/desktop-tabs/desktop-tabs-gate';
import { keepActivePreview } from '@/features/desktop-tabs/desktop-tabs-store';

const CommandPalette = lazy(() =>
  import('@/features/workspace/command-palette').then((mod) => ({
    default: mod.CommandPalette,
  })),
);

const PresentationViewerWrapper = lazy(() =>
  import('@kortix/ui/files/renderers/presentation/presentation-viewer-store').then((mod) => ({
    default: mod.PresentationViewerWrapper,
  })),
);

interface ProjectShellProps {
  projectId: string;
  initialSidebarOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Read the sidebar's persisted open/collapsed state from the `sidebar_state`
 * cookie that {@link SidebarProvider} writes on every toggle. Client-only —
 * the shell is gated behind client auth, so the provider never renders during
 * SSR and this cannot cause a hydration mismatch.
 */
function readSidebarOpenCookie(): boolean | undefined {
  if (typeof document === 'undefined') return undefined;
  return parseSidebarStateCookie(document.cookie);
}

export function ProjectShell({ projectId, initialSidebarOpen, children }: ProjectShellProps) {
  const resolvedSidebarOpen = initialSidebarOpen ?? readSidebarOpenCookie();
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState<boolean | undefined>(
    resolvedSidebarOpen,
  );

  const activeSidebarOpen = sidebarOpen ?? resolvedSidebarOpen ?? true;

  const handleSidebarOpenChange = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      if (typeof document !== 'undefined') {
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
      }
    },
    [],
  );

  const { user, isLoading: authLoading, bootstrapError } = useAuth();

  // Warms the config cache for the capability pages; nothing in the shell waits on it.
  const { data: projectDetail } = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  // The owning account rides the bare project row (~10 ms on the server).
  // `/detail` reads git (0.5–2.6 s on prod) and every billing read on the
  // page, the model picker's gate included, waited behind it.
  const { data: projectRow, error: projectRowError, isStale: projectRowStale } = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const projectAccountId = projectRow?.account_id ?? projectDetail?.project?.account_id;

  useGatewayCatalogSync(projectId);
  // Fill every Customize tab's cache on the first idle slot, so opening
  // Customize renders from memory instead of waiting on the API.
  useCustomizePrefetch(projectId);
  // GET needs-input is polled by the session lists (`useSessionNeedsYouCounts`), once per project.

  useSignedOutRedirect();

  // Remember the project so the next `/` hit and the next sign-in land straight
  // back here instead of going through the id-free landing door. Gated on a
  // project-row read the server confirmed (`GET /projects/:id` asserts read
  // access, like the detail, without waiting on git): recording a project the user cannot
  // actually read would send them into a 404 bounce loop on their next visit.
  // A copy restored from this device's cache is stale until it refetches, and
  // it outlives a deleted project: never remember that stale copy again.
  // ProjectAccessBoundary owns terminal errors and forgetting unreadable projects.
  useEffect(() => {
    if (!projectRow || projectRowError || projectRowStale) return;
    writeLastProjectId(user?.id, projectId);
  }, [projectRow, projectRowError, projectRowStale, projectId, user?.id]);

  // The project's owning account, falling back to the app-wide selected one
  // — the same resolution every account-scoped surface uses. Feeds the
  // `?customize=` redirect below, which can name an account-scoped section.
  const shellAccountId = useSettingsAccountId(projectAccountId);
  // An open project brands as ITS account (Enterprise branding), even when the
  // switcher's selected account is another one. Clears on unmount.
  useBrandingScope(projectAccountId);

  useEffect(() => {
    // Old bookmarks/links carry `?customize=<legacy-section-id>`. Files,
    // Connectors, Skills, and Commands graduated out of the overlay into
    // their own pages; every other legacy id resolves through
    // `legacySectionRedirect` to its `/settings/<tab>` route, which itself
    // opens the Settings overlay via the store and bounces back here — see
    // that route's header comment. An unrecognized id just drops the stale
    // query param.
    const raw = searchParams.get('customize');
    if (!raw) return;
    // Organization, Billing, Usage, Groups, Roles, Identity, Audit log and
    // API keys resolve to `/accounts/<accountId>`, so they need the id this
    // shell already holds. Hold the redirect until it resolves rather than
    // dropping the param — the detail query is in flight for the first few
    // hundred ms of a cold load, and firing early would silently discard the
    // destination the link named. Unlike the deep-link routes, this shell has
    // something to render meanwhile, so waiting costs nothing.
    if (isAccountGraduatedSection(raw) && !shellAccountId) return;
    const redirect = legacySectionRedirect(projectId, raw, shellAccountId);
    if (redirect) {
      router.replace(redirect);
      return;
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete('customize');
    const query = next.toString();
    // `history.replaceState`, not `router.replace`: this branch only drops a
    // stale query key the shell already ignores, so there is no server data to
    // fetch. Dropping a param changes the router cache key, so `router.replace`
    // would miss the segment cache and run a cold RSC fetch for nothing — on
    // the component every `/workspaces/*` page mounts. Next patches
    // `replaceState` and updates its own canonical URL, so `useSearchParams`
    // still reports the stripped URL. Same mechanism as `openTabAndNavigate` in
    // `packages/ui/src/internal/stores/tab-store.ts`.
    //
    // The path comes from `window.location.pathname`, never a hardcoded
    // `/workspaces/<id>`. This shell is mounted by
    // `app/(app)/workspaces/[id]/layout.tsx`, so the effect runs on EVERY route
    // beneath it, and rewriting the address bar to the project root while
    // `/workspaces/<id>/files` is still the rendered view desyncs the two: the
    // sidebar's active-row test stops matching, Back leaves for somewhere the
    // user never was, and a reload lands on a different screen. Only the query
    // key is being dropped here — the path must not move.
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [projectId, router, searchParams, shellAccountId]);

  useEffect(() => {
    try {
      const backend = (process.env.NEXT_PUBLIC_BACKEND_URL || window.location.origin).replace(
        /\/v1\/?$/,
        '',
      );
      const origin = new URL(backend).origin;
      const existing = document.querySelector(`link[rel="preconnect"][href="${origin}"]`);
      if (existing) return;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = '';
      document.head.appendChild(link);
      return () => {
        link.remove();
      };
    } catch {
      /* preconnect is best-effort */
    }
  }, []);

  // The sidebar's Download app row opens this; a stable callback keeps the
  // sidebar from re-rendering on every shell render.
  const [downloadOpen, setDownloadOpen] = useState(false);
  const openDownloadApp = useCallback(() => setDownloadOpen(true), []);

  // New-session navigation opens the project composer. The first send creates
  // the durable session.
  const newSession = useNewProjectSession(projectId);
  const handleNewSession = useCallback(() => {
    newSession();
  }, [newSession]);

  // Spaces on: "New session" (Mod+T, the desktop File menu) opens the
  // person's own space and focuses its composer, where a message starts a thread.
  const channels = useFeatureFlag(projectId, 'chat').enabled;
  const openDefaultChannel = useCallback(() => {
    router.push(`${uiRoutes().project(projectId)}/chat`);
    // Already on that space the composer does not remount; ask it for focus.
    window.dispatchEvent(new CustomEvent('focus-session-textarea'));
  }, [projectId, router]);
  useProjectShellShortcuts({ projectId, onNewSession: channels ? openDefaultChannel : handleNewSession });

  const params = useParams<{ sessionId?: string }>();
  const activeSessionId = params?.sessionId ?? null;

  const openTab = useProjectSessionTabsStore((s) => s.openTab);

  // No workspace page opens until the viewer can run a model: a new workspace
  // lands on "Connect a model" right after setup, and so does any workspace
  // whose models are all gone (Free plan, nothing connected). Paid plans run
  // on Kortix models and pass.
  const modelGate = useWorkspaceModelGate(projectId);

  useLayoutEffect(() => {
    if (activeSessionId) openTab(projectId, activeSessionId);
  }, [projectId, activeSessionId, openTab]);

  if (bootstrapError) return <ProjectPendingScreen />;

  if (authLoading || !user) {
    return <div className="bg-background min-h-screen" />;
  }

  // The same frame the access check and the route loaders paint, so a
  // workspace that waits for its model answer shows one continuous screen.
  if (modelGate === 'pending') return <ProjectPendingScreen />;

  if (modelGate === 'blocked') {
    return (
      // The account the upgrade dialog and the plan check read: this workspace's.
      <BillingAccountProvider accountId={projectAccountId ?? null} resolved={!!projectAccountId}>
        <ConnectModelStep projectId={projectId} workspaceName={projectRow?.name} />
        {isBillingEnabled() && <GlobalUpgradeModal />}
      </BillingAccountProvider>
    );
  }

  return (
    // `resolved` is what keeps the sidebar's billing items from flickering:
    // until the project row lands we don't know this project's account, and a
    // provisional fetch against the primary account would paint them once,
    // then unpaint them when the real account id swaps the cache slot.
    <BillingAccountProvider
      accountId={projectAccountId ?? null}
      resolved={!!projectAccountId}
    >
      <AppProviders
        showSidebar
        showGlobalUserSettingsModal={false}
        defaultSidebarOpen={resolvedSidebarOpen}
        sidebarOpen={activeSidebarOpen}
        onSidebarOpenChange={handleSidebarOpenChange}
        sidebarContent={
          <ProjectSidebar
            projectId={projectId}
            collapsible="offcanvas"
            menu={<WorkspaceSwitcher projectId={projectId} />}
            onOpenSearch={openCommandPalette}
            onOpenDownloadApp={openDownloadApp}
          />
        }
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <CommandPaletteBoundary>
            <CommandPalette />
          </CommandPaletteBoundary>

          <ProjectSheelLayout projectId={projectId}>{children}</ProjectSheelLayout>
        </div>

        <SettingsPanel projectId={projectId} />

        {/* Outside the sidebar: on a phone the sidebar sheet unmounts its rows. */}
        <DownloadModal open={downloadOpen} onOpenChange={setDownloadOpen} />

        {/* Drive uploads report here, on every page of the project, so a batch
            started in one folder still shows its progress after the user moves
            on. Empty, it renders nothing. */}
        <DriveUploadTray />

        {/* A voice call placed from an agent's page (flag `voice_call`): it goes on wherever the person goes in the
            project. Without a call, nothing. */}
        <VoiceCallCard />

        {/* App previews and artifact pages load here in the background and
            stay loaded while the project is open, so the Apps and Artifacts
            pages show them at once. Not started by a settings page. */}
        <PreviewPool projectId={projectId} />

        <Suspense fallback={null}>
          <PresentationViewerWrapper />
        </Suspense>

        <PersonalOnboardingWelcome projectId={projectId} />
      </AppProviders>
    </BillingAccountProvider>
  );
}

/**
 * The background preview pool, started by the first project route that is not
 * a settings page (`previewPoolAllowed`) and kept mounted after that, so a move
 * into settings keeps the warm frames and a move back loads nothing again.
 */
function PreviewPool({ projectId }: { projectId: string }) {
  usePreviewPoolProject(projectId);
  const allowed = previewPoolAllowed(usePathname());
  // Started per project. A project switch normally remounts the shell, but
  // if a shell is ever reused, any project change resets the latch (a
  // settings page included): the old project's frames are gone
  // (`usePreviewPoolProject`).
  const [pool, setPool] = useState({ projectId, started: allowed });
  if (pool.projectId !== projectId || (allowed && !pool.started)) {
    setPool({ projectId, started: allowed });
  }
  if (pool.projectId !== projectId || !pool.started) return null;
  return (
    <>
      <AppPreviewPoolLoader projectId={projectId} />
      {/* Artifact pages too, in the same frame pool (flag `artifacts`). */}
      <ArtifactFramePreloader projectId={projectId} />
    </>
  );
}

/** A control of the page (not a link): pressing one is working in the page. */
const PAGE_CONTROLS =
  'button, input, select, textarea, summary, [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="combobox"], [role="menuitem"]';

const ProjectSheelLayout = ({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) => {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const { state, isMobile, toggleSidebar, peek, peekEnter, peekLeave } = useSidebar();
  const isExpanded = !isMobile && state === 'expanded';
  // The sidebar hides fully when collapsed (offcanvas everywhere, no icon
  // rail), so a hidden sidebar means no seam border and no way back from the
  // panel itself. On the desktop shell the reopen control lives HERE, in the
  // OS title-bar band; on the web each view draws its own. Shared gate so the
  // two can never both render — see sidebar-opener.ts.
  const desktopShell = useDesktopShell();
  // The desktop window's tab strip owns the title-bar band; every project view
  // renders below it. Every window width, down to the 720 × 480 minimum (where
  // the sidebar is a sheet and the shell's toggle still opens it).
  // Behind the project's `desktop_tabs` flag. A strip that throws turns
  // itself off for this window (`stripFailed`), and the title bar is back.
  const [stripFailed, setStripFailed] = useState(false);
  const tabsEnabled = useDesktopTabsEnabled(projectId);
  const tabs = !!desktopShell && tabsEnabled && !stripFailed;
  const tabsVisible = useDesktopTabsVisible(projectId);
  return (
    <div
      // The page's own header moves below the strip only while the strip shows.
      data-kx-desktop-tabs-on={tabs && tabsVisible ? '' : undefined}
      // Typing in the page, or pressing one of its controls, is working in it:
      // the preview tab becomes a kept tab. A link is not: it navigates.
      onInputCapture={tabs ? () => keepActivePreview(projectId) : undefined}
      onClickCapture={
        tabs
          ? (event) => {
              const target = event.target as Element;
              if (target.closest('[data-kx-desktop-tabs]')) return;
              if (target.closest(PAGE_CONTROLS)) keepActivePreview(projectId);
            }
          : undefined
      }
      className={cn(
        'bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden',
        isExpanded && 'border-border border-l',
      )}
      // The sidebar navigates and the toggle below owns the band's corner, so
      // the window's desktop Back (root layout) steps aside on every project view.
      data-kx-titlebar-owner=""
    >
      {/* Collapsed: an invisible strip on the viewport's left edge summons
          the sidebar as a hover flyout; it self-hides while docked open. */}
      <SidebarEdgePeek />
      {/* Some project views start with content instead of a titlebar row. Give
          those views the same native drag band without covering controls on
          views that already own the band. CSS disables this fallback whenever
          the active view contains `.kx-titlebar-row`. */}
      <div aria-hidden="true" className="kx-project-shell-drag-region" />
      {tabs && (
        <DesktopTabsBoundary onError={() => setStripFailed(true)}>
          <DesktopTabStrip projectId={projectId} />
        </DesktopTabsBoundary>
      )}
      {/* Mobile: the sidebar is a sheet with no docked affordance, and view
          headers come and go (sessions render theirs only once booted) — so
          the opener lives here, always mounted, on every project view. The
          session header indents its leading buttons past it below md. */}

      {/* Page headers can share z-50 with this fixed control. Paint the
          control after them so their macOS drag regions cannot take its click. */}
      {children}
      {desktopShell && !isExpanded && (
        <Hint
          label={
            peek ? tI18nComplete.raw('textbc44e1fccb68') : tI18nComplete.raw('text45609089ee73')
          }
          side="bottom"
        >
          <Button
            type="button"
            aria-label={
              peek ? tI18nComplete.raw('textbc44e1fccb68') : tI18nComplete.raw('text45609089ee73')
            }
            onClick={toggleSidebar}
            onPointerEnter={peekEnter}
            onPointerLeave={peekLeave}
            variant="ghost"
            // The ONE sidebar opener on the desktop shell — every view-level
            // copy is suppressed by useShowPageSidebarOpener() so this cannot
            // become the second control in the same corner.
            //
            // Placed by the band variables, not by a literal: on macOS the
            // traffic lights are positioned by the Electron main process, so
            // the two numbers live in different processes and used to drift
            // (this box centered at y=26, the lights at y=30). The variables
            // are generated from one table — see globals.css and
            // apps/desktop-electron/src/window-chrome.js. They also carry the
            // Win/Linux values, so there is no platform branch here.
            className={cn(TITLEBAR_CONTROL_CLASS, 'flex w-[var(--kx-titlebar-control-size)]')}
          >
            <PanelLeft className="cn-rtl-flip size-4" />
          </Button>
        </Hint>
      )}
      {/* On the web there is deliberately no shell-level opener: each view
          draws its own, in its own layout, gated by
          useShowPageSidebarOpener(). Only the desktop shell needs a
          shell-level one, because only there is the corner owned by the OS. */}
    </div>
  );
};

export default ProjectSheelLayout;
