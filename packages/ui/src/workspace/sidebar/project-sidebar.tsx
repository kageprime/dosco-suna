'use client';

import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Kbd, KbdGroup } from '../../primitives/kbd';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '../../primitives/sidebar';
import { ComputerConnectModal } from '../../internal/tunnel/computer-connect';
import { ConnectMcpModal } from '../../internal/layout/connect-mcp-modal';
import { ProjectPromoCards } from './footer/project-promo-cards';
import { ProjectManifestIssuesAlert } from './footer/project-manifest-issues-alert';
import { ProjectSandboxAlert } from './footer/project-sandbox-alert';
import { ProjectRepositoryDisconnectedAlert } from '../repository-disconnected';
import { NewAgentModalProvider } from './new-agent-modal-provider';
import { ProjectNavItems } from './project-nav-items';
import { ProjectSessionList } from './project-session-list';
import { ProjectSpacesNav } from './project-spaces-nav';
import { SidebarMoreGroup } from './sidebar-more-group';
import { useIsCreatingProjectSession } from '../../internal/hooks/projects/new-session-guard';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { useIsMobile } from '../../internal/hooks';
import { useTranslations } from '../../i18n';
import { cn } from '../../internal/lib/utils';
import { useBillingAccountId } from '../../internal/stores/billing-account-context';
import { useFeatureFlag } from '@kortix/sdk/react';
import { AppsModal } from '../../internal/apps-and-extensions/apps-modal';
import { useAppsModalStore } from '../../internal/stores/apps-modal-store';
import {
  ArrowUpRightIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  NavigationArrowIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname, useUiRouter } from '../../providers/ui-provider';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { reviewHref } from '../../internal/lib/capability-tab-routes';
import { SettingsReturnTracker, SidebarDrill } from './sidebar-drill';
import { ProjectRail } from './project-rail';
import { SpaceFormModal } from '../session-spaces/space-form-modal';
import { isProjectAdminPath } from '../../internal/layout/project-capability-nav';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SidebarBalanceWarning } from './footer/project-balance-warning';
import { SidebarUpgradeButton } from './footer/project-upgrade-button';
import { SidebarGlyph as PanelLeft } from '../../icons/sidebar-toggle';
import { Close } from '../../icons/close';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? 'Ã¢Å’Ëœ' : 'Ctrl';


/**
 * Workspace pages with a centered bottom composer: home, one session (not the
 * Sessions list), and `/setup`, whose modal opens over home with its banner.
 */
const CENTERED_COMPOSER_ROUTE = /\/workspaces\/[^/]+(?:\/setup|\/sessions\/[^/]+(?:\/.*)?)?\/?$/;
/** Workspace pages whose composer runs to the right edge: chat, DMs, channels, Spaces. */
const FULL_COMPOSER_ROUTE = /\/workspaces\/[^/]+\/(?:c|chat|dm|spaces)(?:\/.*)?$/;
export function ProjectSidebar({
  projectId,
  menu,
  help,
  onOpenSearch,
  onOpenDownloadApp,
}: {
  projectId: string;
  /**
   * The footer's help control (apps/web passes `HelpMenu`: docs, support,
   * shortcuts, status, what's new). Without it, the sidebar has no footer.
   */
  help?: ReactNode;
  /**
   * Opens the host's Download app dialog. Without it, the footer has no
   * Download app row.
   */
  onOpenDownloadApp?: () => void;
  /**
   * Opens the host's search (apps/web: its command palette). Without it, the
   * header has no Search button.
   */
  onOpenSearch?: () => void;
  /**
   * The header's first control: who is signed in, the workspace, account
   * actions (apps/web passes `WorkspaceSwitcher`). Without it, the header
   * shows only the sidebar's own buttons.
   */
  menu?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('sidebar');
  const tCommon = useTranslations('common');
  const { state, setOpenMobile, toggleSidebar, peek } = useSidebar();
  const isExpanded = state === 'expanded';
  const isMobile = useIsMobile();
  const pathname = useUiPathname();
  const sessionsGroupRef = useRef<HTMLDivElement>(null);
  // The icon rail (`sidebar_rail`), desktop only. Off, or on a phone, the
  // sidebar is the one without a rail: every `railed` branch below falls through.
  const railFlag = useFeatureFlag(projectId, 'sidebar_rail').enabled;
  const railed = !isMobile && railFlag;
  // With the rail, the panel shows the sessions, or workspace settings by the route.
  const settingsOpen = isProjectAdminPath(pathname);
  // Collapsed and hovered on the rail: the hovered item picks the list, not the route.
  const [peekSection, setPeekSection] = useState<'home' | 'spaces' | 'customize'>('home');
  const peeking = railed && !isExpanded && peek;
  const peekOverride = peeking ? peekSection === 'customize' : undefined;
  const showingSettings = peekOverride ?? settingsOpen;
  // The rail's Spaces (`session_groups`): the panel lists the spaces on a spaces page, or while Spaces is hovered.
  const groupsOn = useFeatureFlag(projectId, 'session_groups').enabled;
  const spacesHref = groupsOn ? (uiRoutes().sessionSpaces?.(projectId) ?? null) : null;
  const spacesOpen = !!spacesHref && !!pathname && (pathname === spacesHref || pathname.startsWith(`${spacesHref}/`));
  const showingSpaces = railed && !showingSettings && (peeking ? peekSection === 'spaces' : spacesOpen);
  // New space, from the Spaces title row (rail only).
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  // Chat on, rail: the panel shows the chats or the sessions.
  const [chatTab, setChatTab] = useState<'chat' | 'sessions'>('chat');
  // Review on the Chat tab's title row: for the people who may act on it (the Review row's own rule).
  const reviewAccess = useCapabilityAccess(projectId);
  const reviewPage = reviewHref(projectId);
  const reviewLink =
    reviewPage && reviewAccess.settled && reviewAccess.tabs.includes('review')
      ? { href: reviewPage, active: !!pathname?.startsWith(reviewPage.split('?')[0]!) }
      : null;
  // The Sessions title row's right edge (rail only): the session list draws its view options button there.
  const [sessionsFilterSlot, setSessionsFilterSlot] = useState<HTMLDivElement | null>(null);
  const router = useUiRouter();
  const tGroups = useTranslations('sidebar.sessionGroups');
  // Mounted outside <Sidebar>: the mobile sheet unmounts its content on close.
  const [computerConnectOpen, setComputerConnectOpen] = useState(false);
  const [connectMcpOpen, setConnectMcpOpen] = useState(false);

  // Settings drill (`SidebarDrill`): a click there closes the mobile sheet.
  const handleDrilledNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const accountId = useBillingAccountId();
  // Chat (`chat`): the spaces list replaces New session, and the session list
  // moves below it, closed by default (fail-closed: off until the project answers).
  const chat = useFeatureFlag(projectId, 'chat').enabled;
  const chrome = useFeatureFlag(projectId, 'chrome').enabled;

  // Open the project composer without creating a durable session.
  const newSession = useNewProjectSession(projectId);
  const creatingSession = useIsCreatingProjectSession(projectId);
  // Cmd+J only. The row itself is an anchor (below), so the keyboard path is
  // the one entry point left that has to ask the hook to navigate.
  const handleNewSession = useCallback(() => {
    newSession();
    if (isMobile) setOpenMobile(false);
  }, [newSession, isMobile, setOpenMobile]);
  // The anchor performs the navigation; this keeps the row's one side effect.
  const handleNewSessionClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  // Shared by the row's anchor and its creating-session state, which stays a
  // real <button> so `disabled` still holds. The shortcut hint is desktop
  // only: a phone has no keyboard, and the tap's sticky hover revealed the
  // hint anyway (KRTX-2005).
  const newSessionRowBody = (
    <>
        <span className="shrink-0">
          <NavigationArrowIcon className="rotate-90" />
        </span>
        <span>{t('newSession')}</span>
        {!isMobile && (
          <KbdGroup className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 group-hover/menu-button:opacity-100">
            <Kbd>{modSymbol}</Kbd>
            <Kbd>J</Kbd>
          </KbdGroup>
        )}
    </>
  );

  // Mobile: the sidebar is a Sheet, so leaving it open would stack the palette
  // dialog on top of it. Dismiss it first Ã¢â‚¬â€ same order as opening a new
  // session from here.
  const handleOpenSearch = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    onOpenSearch?.();
  }, [isMobile, setOpenMobile, onOpenSearch]);

  // Cmd+J opens the new-session composer with `chat` on too (`newSessionHref`).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'j' || event.key === 'J')
      ) {
        event.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewSession]);

  // The connect rows and the upgrade call to action. Spaces on (`chat`), they
  // live inside "More": the bottom of the sidebar is More and the status alerts.
  const connectRows = (
    <>
              {/* One card for every promo: MCP, the computer, Chrome, the
                  desktop app, the phone app. An empty list collapses. */}
              <li className="not-has-[li]:hidden">
                <ul className="pb-1">
                  {/* Phone only: on desktop the card floats in the window's
                      corner (mounted below, outside the sidebar). */}
                  {isMobile ? (
                    <ProjectPromoCards
                      projectId={projectId}
                      onOpenMcp={() => setConnectMcpOpen(true)}
                      onOpenComputer={() => setComputerConnectOpen(true)}
                      onOpenChrome={chrome ? () => useAppsModalStore.getState().setOpen(true) : undefined}
                      onOpenDownloadApp={onOpenDownloadApp}
                    />
                  ) : null}
                </ul>
              </li>
              {/* Last (Jay, 2026-09-03). It is the only paid call to action in
                  this group, and above the nav rows it put a sell between the
                  user and the links they actually use. */}
              <SidebarUpgradeButton accountId={accountId} />
    </>
  );

  return (
    // The New agent modal mounts beside <Sidebar>, outside the mobile sheet.
    <NewAgentModalProvider projectId={projectId}>
    <Sidebar
      collapsible="offcanvas"
      variant="inset"
      rail={
        railed ? (
          <ProjectRail
            projectId={projectId}
            onOpenSearch={onOpenSearch ? handleOpenSearch : undefined}
            help={help}
            settingsOpen={settingsOpen}
            onPeek={setPeekSection}
          />
        ) : undefined
      }
      // No background here. This className lands on the sidebar CONTAINER —
      // the square positioning box — while the visible card is the rounded

      // inner box, which already carries `bg-sidebar`. Painting it twice put a
      // square fill behind the flyout card and it showed at all four corners.
      className="[scrollbar-width:'none'] [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden"
    >
      <SidebarHeader
        className="kx-project-sidebar-header space-y-2"
        data-peek={peek ? '' : undefined}
      >
        {/* Offcanvas everywhere: the whole panel slides, so the header keeps a
            single layout. Up to three controls on one 240px row, all 32px
            tall: the merged brand/switcher control, search, and the panel's
            own collapse toggle Ã¢â‚¬â€ so the collapse control sits inside
            the thing it collapses and the session header no longer has to
            carry a toggle while the panel is docked open.

            ONE control answers "who am I / where am I / where can I go". It was
            three: a `<Link>` carrying the Dosco mark fused to a separate
            dropdown trigger carrying the workspace name up here, plus the user
            menu as a third control down in the footer Ã¢â‚¬â€ two of the three being
            dropdowns. The link is gone, because a control that is half
            navigation and half disclosure makes you guess which half you are
            pointing at. The workspace directory is now a second VIEW of this
            menu, behind "Switch Workspace", which is why there is no footer
            control below any more. */}
        {railed ? (
          // The rail carries search, the toggle and help; the panel names what it shows.
          <div
            className={cn(
              'flex w-full items-center gap-1 px-2',
              !peek && 'kx-titlebar-row kx-titlebar-band-height kx-project-sidebar-titlebar',
            )}
          >
            {chat && !showingSettings && !showingSpaces ? (
              // Chat on: two views of the panel, the chats and the sessions.
              <Tabs value={chatTab} onValueChange={(value) => setChatTab(value as 'chat' | 'sessions')} className="min-w-0 flex-1">
                {/* `-ml-2.5` cancels the first trigger's `px-2.5`: its label starts on the list's label edge. */}
                <TabsList variant="secondary" size="sm" className="-ml-2.5">
                  <TabsTrigger value="chat" className="w-fit flex-none px-2.5">
                    {t('spaces.chat')}
                  </TabsTrigger>
                  <TabsTrigger value="sessions" className="w-fit flex-none px-2.5">
                    {t('sessions')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : (
              <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
                {showingSettings ? t('customize') : showingSpaces ? tGroups('heading') : t('sessions')}
              </span>
            )}
            {showingSettings ? null : showingSpaces ? (
              // Spaces: the Spaces page, then New space, at the row's right edge.
              // `-mr-1.75` cancels the `icon-base` button's inset (29px box, 16px glyph):
              // the last glyph ends on the row's edge, as the title starts on it.
              <div className="-mr-1.75 flex shrink-0 items-center gap-0.5">
                {spacesHref ? (
                  <Hint label={tGroups('allSpaces')} side="bottom">
                    <Button asChild variant="ghost" size="icon-base" className="text-muted-foreground hover:text-foreground">
                      <Link href={spacesHref} prefetch aria-label={tGroups('allSpaces')}>
                        <ArrowUpRightIcon className="cn-rtl-flip size-4" />
                      </Link>
                    </Button>
                  </Hint>
                ) : null}
                <Hint label={tGroups('newGroup')} side="bottom">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-base"
                    aria-label={tGroups('newGroup')}
                    onClick={() => setNewSpaceOpen(true)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                </Hint>
              </div>
            ) : chat && chatTab === 'chat' ? (
              // Review, as an icon at the row's right edge (it is the list's first row without the rail).
              reviewLink ? (
                <Hint label={t('spaces.review')} side="bottom">
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-base"
                    className={cn(
                      'text-muted-foreground hover:text-foreground -mr-1.75',
                      reviewLink.active && 'bg-sidebar-accent text-foreground',
                    )}
                  >
                    <Link
                      href={reviewLink.href}
                      prefetch
                      aria-label={t('spaces.review')}
                      aria-current={reviewLink.active ? 'page' : undefined}
                    >
                      <GitPullRequestIcon className="size-4" />
                    </Link>
                  </Button>
                </Hint>
              ) : null
            ) : (
              <div ref={setSessionsFilterSlot} className="-mr-1.75 flex shrink-0 items-center" />
            )}
          </div>
        ) : (
        <div
          className={cn(
            'flex w-full items-center gap-1',
            !peek && 'kx-titlebar-row kx-titlebar-band-height kx-project-sidebar-titlebar',
          )}
        >
          {menu ? <div className="min-w-0">{menu}</div> : null}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {/* The switcher shrinks before either icon button, so the row
                fits the 208px floor. The inbox is a row in the switcher's
                menu (KRTX-1742), not a header control or a nav row. */}
            {/* Search is the palette's only pointer-reachable entry point Ã¢â‚¬â€
                Ã¢Å’ËœK is otherwise the whole discovery story. Renders on mobile
                too: there is no keystroke to fall back on there. The Ã¢Å’ËœK
                keycaps stay desktop-only: on a phone the press's sticky hover
                showed a shortcut that cannot exist there (KRTX-2005). */}
            {onOpenSearch && (
            <Hint
              side="bottom"
              label={
                <span className="flex items-center gap-1.5">
                  {t('search')}
                  {!isMobile && (
                    <KbdGroup>
                      <Kbd className="font-mono">{modSymbol}</Kbd>
                      <Kbd className="font-mono">K</Kbd>
                    </KbdGroup>
                  )}
                </span>
              }
            >
              <Button
                type="button"
                aria-label={t('search')}
                variant="ghost"
                size="icon"
                onClick={handleOpenSearch}
                // The palette's only pointer-reachable entry: the Ã¢â€°Ë†26px ghost
                // box clears the 44px floor with the vertical-only extension Ã¢â‚¬â€
                // vertical-only because this titlebar row packs several
                // controls side by side (KRTX-2004).
                className="shrink-0 hit-area-y-3"
              >
                <MagnifyingGlassIcon className="size-4" />
              </Button>
            </Hint>
            )}
            {isMobile && (
              <Button
                type="button"
                aria-label={tCommon('close')}
                variant="ghost"
                size="icon"
                onClick={() => setOpenMobile(false)}
                className="shrink-0 hit-area-y-3"
              >
                <Close />
              </Button>
            )}
            {/* A desktop hover flyout pins instead of collapsing. */}
            {!isMobile && !peek && (
              <Hint
                side="bottom"

                label={
                  <span className="flex items-center gap-1.5">
                    {isExpanded ? t('collapse') : t('pin')}
                    <KbdGroup>
                      <Kbd className="font-mono">{modSymbol}</Kbd>
                      <Kbd className="font-mono">B</Kbd>
                    </KbdGroup>
                  </span>
                }
              >
                <Button
                  type="button"
                  aria-label={isExpanded ? t('collapse') : t('pin')}
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  className="shrink-0"
                >
                  <PanelLeft className="cn-rtl-flip" />
                </Button>
              </Hint>
            )}
          </div>
        </div>
        )}
      </SidebarHeader>
      {/* One icon lane for every row (Jay, 2026-10-12). Session rows inset
          their status mark by `px-2`; the menu-button recipe insets by
          `px-3`, which put the nav and footer icons ~3.7px right of the
          session marks. `pl-2` here puts every icon at the same x, and its
          centre on the workspace avatar's centre in the header above
          (header `p-2` + switcher `px-1` + half of the `size-6` tile). Left
          side only: right padding still clears trailing badges. */}
      <SidebarContent className="relative min-h-0 flex-1 [scrollbar-width:'none'] overflow-hidden [-ms-overflow-style:'none'] [&::-webkit-scrollbar]:hidden [&_[data-sidebar=menu-button]]:pl-2">
        <SidebarDrill
          projectId={projectId}
          onNavigate={handleDrilledNavigate}
          hideBack={railed}
          drilledOverride={peekOverride}
          instant={railed}
        >
          <SidebarGroup className="py-0">
            <SidebarMenu>
              {chat || showingSpaces ? null : (
                <SidebarMenuItem>
                  {creatingSession ? (
                    <SidebarMenuButton
                      disabled
                      aria-busy
                      className="group/menu-button text-sidebar-foreground relative"
                    >
                      {newSessionRowBody}
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton
                      asChild
                      className="group/menu-button text-sidebar-foreground relative"
                    >
                      <Link href={uiRoutes().project(projectId)} prefetch onClick={handleNewSessionClick}>
                        {newSessionRowBody}
                      </Link>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              )}

              {/* Customize, Apps, Files: order and
                  visibility come from "Customize sidebar". They moved up here
                  from the footer (Jay, 2026-10-12) to keep the footer short. */}
              {/* With the rail, they live in the rail's More menu. */}
              {chat || railed ? null : <ProjectNavItems projectId={projectId} />}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className="min-h-0 flex-1 flex-col py-0" ref={sessionsGroupRef}>
            {chat ? (
              <>
                {/* Channels and Direct messages are the core surface. The
                    session list sits below them, closed by default: every
                    session the viewer runs, threads included. */}
                {/* Spaces on: Review and the Spaces are the only things up
                    top. Everything else (Customize, Drive, Apps, Artifacts,
                    the session list) waits in "More" at the bottom. */}
                {railed && chatTab === 'sessions' ? (
                  <ProjectSessionList projectId={projectId} hideSpaces filterSlot={sessionsFilterSlot} />
                ) : (
                  <div className="min-h-0 flex-1">
                    <ProjectSpacesNav projectId={projectId} review={!railed} />
                  </div>
                )}
                {/* On the rail the panel's tabs pick Chat or Sessions, and the
                    rail's More menu holds the pages: no More row here. */}
                {railed ? null : <SidebarMoreGroup projectId={projectId} footer={<SidebarMenu className="gap-1">{connectRows}</SidebarMenu>} />}
              </>
            ) : (
              <ProjectSessionList
                projectId={projectId}
                hideSpaces={railed && !showingSpaces}
                spacesOnly={showingSpaces}
                filterSlot={railed ? sessionsFilterSlot : undefined}
              />
            )}
          </SidebarGroup>

          <SidebarGroup className="mt-auto">
            <SidebarMenu className="gap-1">
              {/* Status only, then the two connect rows (Jay, 2026-10-12).
                  Navigation lives in the top group. The ChatGPT connect row
                  left the sidebar: it stays in Settings Ã¢â€ â€™ Connected. */}
              <ProjectRepositoryDisconnectedAlert projectId={projectId} />
              <ProjectSandboxAlert projectId={projectId} />
              <ProjectManifestIssuesAlert projectId={projectId} />
              <SidebarBalanceWarning accountId={accountId} />
              {chat ? null : connectRows}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarDrill>
      </SidebarContent>

      {/* Help sits alone at the foot: a person looks for it at the bottom of
          the navigation. `pl-2.5` puts its glyph on the rows' icon lane above. */}
      {railed ? (
        // With the rail, Help is on the rail and the workspace switcher sits at the panel's foot.
        menu ? <SidebarFooter className="pt-0">{menu}</SidebarFooter> : null
      ) : help ? (
        <SidebarFooter className="flex-row pt-0 pl-2.5">{help}</SidebarFooter>
      ) : null}

      <SidebarRail aria-label={t('resize')} title={t('resizeHelp')} />
    </Sidebar>
    <SettingsReturnTracker projectId={projectId} />
    {/* Desktop: the promo card floats in the window's bottom-right corner,
        outside the sidebar and its More disclosure, so it shows whether or
        not the sidebar or More is open. */}
    {isMobile ? null : (
      <ProjectPromoCards
        projectId={projectId}
        onOpenMcp={() => setConnectMcpOpen(true)}
        onOpenComputer={() => setComputerConnectOpen(true)}
        onOpenChrome={chrome ? () => useAppsModalStore.getState().setOpen(true) : undefined}
        onOpenDownloadApp={onOpenDownloadApp}
        variant="floating"
        composer={
          FULL_COMPOSER_ROUTE.test(pathname)
            ? 'full'
            : CENTERED_COMPOSER_ROUTE.test(pathname)
              ? 'centered'
              : undefined
        }
      />
    )}
    <ComputerConnectModal
      projectId={projectId}
      open={computerConnectOpen}
      onOpenChange={setComputerConnectOpen}
    />
    {railed ? (
      <SpaceFormModal
        projectId={projectId}
        space={null}
        open={newSpaceOpen}
        onOpenChange={setNewSpaceOpen}
        onSaved={(space) => {
          const href = uiRoutes().sessionSpace?.(projectId, space.group_id);
          if (href) router.push(href);
        }}
      />
    ) : null}
    <AppsModal
      chrome={chrome}
      onOpenComputer={() => setComputerConnectOpen(true)}
      onOpenMcp={() => setConnectMcpOpen(true)}
    />
    <ConnectMcpModal open={connectMcpOpen} onOpenChange={setConnectMcpOpen} />
    </NewAgentModalProvider>
  );
}
