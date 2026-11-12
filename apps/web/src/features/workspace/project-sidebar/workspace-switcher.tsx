'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
/**
 * The project sidebar's one control: which workspace you are in, and everything
 * you can do from here.
 *
 * It is a WORKSPACE switcher, not a user menu — the distinction is the whole
 * point of the component existing separately from `UserMenu` in the app header.
 * The trigger shows the workspace, not you: its icon (an emoji if one is set,
 * otherwise the initials `EntityAvatar` derives from the name) and its name, the
 * same treatment the rows inside the switcher use, so the thing you are in looks
 * like the things you can move to. The account rows (Preferences, Log out) sit
 * below the workspace rows.
 *
 * The menu, top to bottom (`workspaceMenuGroups`): "Switch workspace" (the
 * list, with the pending-invitation count, and "Create workspace" at its
 * foot) → "Workspace settings" (`/workspaces/<id>/admin`) → "Invite people"
 * (`project.members.manage`) → Inbox → "Preferences" (the person's own
 * settings overlay; it keeps Mod+,) → "Apps and extensions" → Help → Log out,
 * as a plain row. Rename lives in Workspace settings ›
 * General and Leave in its Danger zone; a person who cannot open Workspace
 * settings gets "Leave {name}" here instead. Appearance lives in Preferences;
 * Download app is a dismissible row at the foot of the sidebar.
 *
 * Preferences pokes `useSettingsPanelStore.openSettings('profile')`: this
 * control only renders under `ProjectShell`, which mounts `SettingsPanel` as a
 * sibling, so the overlay opens in place.
 *
 * Help and Log out are shared through `user-menu-shared.tsx` rather than
 * copied.
 *
 * This replaced three controls: a `<Link>` carrying the Kortix mark fused to a
 * separate dropdown trigger carrying the workspace name, plus a user menu in the
 * sidebar footer. Two of the three were dropdowns, and the fused one made you
 * guess which half you were pointing at — the left half navigated, the right
 * half disclosed.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import {
  SidebarContext,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@kortix/ui/sidebar';
import { Skeleton } from '@kortix/ui/skeleton';
import { HelpSubmenu, useLogoutFlow } from '@/features/layout/user-menu-shared';
import { COMPUTER_SETUP_EVENT } from '@kortix/ui/internal/tunnel/computer-connect';
import { LocalComputerModal } from '@/features/tunnel/local-computer-modal';
import { PROJECT_ACTIONS } from '@kortix/sdk';
import { useProjectCan } from '@kortix/ui/internal/lib/use-project-can';
import { WorkspaceMenuSection } from '@kortix/ui/workspace/sidebar/workspace-menu-section';
import { workspaceMenuGroups, type WorkspaceMenuRow } from '@kortix/ui/workspace/sidebar/workspace-menu-model';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { useLeaveWorkspace } from '@kortix/ui/workspace/settings/use-leave-workspace';
import { useCapabilityAccess } from '@kortix/ui/internal/layout/project-settings-nav';
import { useMyInvites } from '@kortix/ui/internal/hooks/account/use-my-invites';
import { CountBadge } from '@kortix/ui/count-badge';
import { workspaceSettingsPath } from '@kortix/shared/workspace-settings';
import { canCreateWorkspace } from '@kortix/ui/workspace/project-selector/project-selector-model';
import { settingsShortcutLabel } from '@/features/workspace/settings/settings-shortcut';
import { type SettingsTab } from '@kortix/ui/customize/settings/settings-tabs';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useAdminRole } from '@kortix/ui/internal/hooks/admin/use-admin-role';
import { isAccountCreationRestricted } from '@/lib/config';
import { cn } from '@kortix/ui';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { useAppsModalStore } from '@kortix/ui/internal/stores/apps-modal-store';
import { getProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useInboxSummary } from '@kortix/ui/internal/notifications/use-inbox-summary';
import {
  ArrowsLeftRightIcon,
  BellIcon,
  CaretUpDownIcon,
  GearSixIcon as CogOne,
  DoorOpenIcon,
  SignOutIcon as LogOut,
  PlusIcon,
  PuzzlePieceIcon,
  SlidersHorizontalIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { useEffect, useState } from 'react';

export function WorkspaceSwitcher({ projectId }: { projectId: string }) {
  const t = useI18nTranslations('sidebar');
  const tWorkspaces = useI18nTranslations('workspaces.switcher');
  const tWorkspaceMenu = useI18nTranslations('workspaces.menu');
  // "Invite people" follows the palette's gate; "Workspace settings" follows
  // Customize › Workspace settings (`config`).
  const canInvite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const canOpenSettings = useCapabilityAccess(projectId).tabs.includes('config');
  const leave = useLeaveWorkspace(projectId);
  const inviteCount = useMyInvites().data?.length ?? 0;
  const directory = useWorkspaceDirectory();
  const tNotifications = useI18nTranslations('notifications');
  const inbox = useInboxSummary(projectId);
  const sidebar = React.useContext(SidebarContext);
  const [menuOpen, setMenuOpen] = useState(false);

  // Seeds `selectedAccountId` for a brand-new sign-in. Pre-merge this ran here
  // by way of a `UserMenu` in the project sidebar's FOOTER. That footer menu no
  // longer exists: `ProjectSidebar` renders THIS control and nothing else menu-
  // like (`project-sidebar.tsx:116`), and `UserMenu` has no remaining mount.
  // So the call moved here with the control rather than being silently
  // dropped: without it, every account-scoped settings tab
  // opened on a project whose detail query has not resolved yet has no account
  // id to probe with, and renders as though the permission were denied. Same
  // `useAccountsList()` hook as every other caller, so React Query serves them
  // all from one user-scoped fetch.
  useEnsureSelectedAccount();

  const [computerSetupOpen, setComputerSetupOpen] = useState(false);
  // Right after this desktop pairs, setup opens on the spot (see COMPUTER_SETUP_EVENT).
  // The sidebar's computer row and the Connectors pages open the other dialogs.
  useEffect(() => {
    const openSetup = () => setComputerSetupOpen(true);
    window.addEventListener(COMPUTER_SETUP_EVENT, openSetup);
    return () => window.removeEventListener(COMPUTER_SETUP_EVENT, openSetup);
  }, []);
  const { data: adminRole } = useAdminRole();
  // "Create workspace" makes an account and its project. Self-host can
  // restrict account creation to platform admins
  // (`KORTIX_RESTRICT_ACCOUNT_CREATION`); the backend 403
  // (`account_creation_restricted`) stays the authoritative gate, this only
  // avoids offering a row the person cannot use.
  const restricted = isAccountCreationRestricted();
  const isPlatformAdmin = Boolean(adminRole?.isAdmin);
  const canCreate = canCreateWorkspace({ restricted, isPlatformAdmin });

  // For the rows that OPEN something in place — the settings panel, the log-out
  // confirmation. Navigating rows do not use it: they are anchors now, and an
  // anchor needs no deferral because the App Router owns the transition.
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const openUserSettings = (tab: SettingsTab) =>
    deferAfterClose(() => useSettingsPanelStore.getState().openSettings(tab));

  const { openConfirm: openLogoutConfirm, dialog: logoutDialog } = useLogoutFlow(deferAfterClose);

  // `qk.project.summary(id)` is the canonical `getProject` slot — the same entry
  // the rest of the project shell reads, so naming the workspace here costs no
  // extra request. NOT the projects LIST: that waits on `accounts` first, and
  // this control paints before either resolves.
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const project = projectQuery.data ?? null;

  // In the collapsed sidebar's hover flyout, the menu content portals outside
  // the panel — hovering it fires the panel's pointer-leave and would collapse
  // the flyout out from under the open menu. Pin the flyout while it is up.
  React.useEffect(() => {
    if (!menuOpen) return;
    sidebar?.holdPeek(true);
    return () => sidebar?.holdPeek(false);
  }, [menuOpen, sidebar]);

  const menuGroups = workspaceMenuGroups({
    canInvite,
    canOpenSettings,
    canLeave: leave.canLeave,
    hasInbox: inbox.href !== null,
  });
  const renderRow = (row: WorkspaceMenuRow): React.ReactNode => {
    switch (row) {
      case 'invite':
        return (
          <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
            <Link href={`${workspaceSettingsPath(projectId, 'members')}?invite=1`} prefetch>
              <UserPlusIcon />
              {/* The trigger above already names the workspace. */}
              <span className="min-w-0 flex-1 truncate">{tWorkspaceMenu('invitePeople')}</span>
            </Link>
          </DropdownMenuItem>
        );
      case 'settings':
        return (
          <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
            <Link href={workspaceSettingsPath(projectId)} prefetch>
              <CogOne />
              {tWorkspaces('settings')}
            </Link>
          </DropdownMenuItem>
        );
      case 'switch':
        return (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowsLeftRightIcon />
              <span className="min-w-0 flex-1 truncate">{tWorkspaces('switch')}</span>
              {/* An invite that arrives later is found here: the count shows
                  without opening the list. */}
              {inviteCount > 0 ? <CountBadge count={inviteCount} tone="waiting" /> : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-[264px] space-y-0.5" sideOffset={6}>
                {/* Anchors, not handlers: `router.push` from a menu row runs the
                    RSC fetch cold at click time. */}
                <WorkspaceMenuSection
                  actions={
                    canCreate
                      ? () => (
                          // Create sits under the list it adds to, not beside
                          // the workspace's own rows.
                          <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
                            <Link href="/workspaces/new" prefetch>
                              <PlusIcon />
                              {tWorkspaces('create')}
                            </Link>
                          </DropdownMenuItem>
                        )
                      : undefined
                  }
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        );
      case 'inbox':
        // The person's notifications from every workspace (KRTX-1742). An
        // anchor, like the other navigating rows. It left the sidebar's nav
        // rows: a page you visit when something calls you needs no permanent row.
        return inbox.href ? (
          <DropdownMenuItem asChild onSelect={() => setMenuOpen(false)} size="sm">
            <Link href={inbox.href} prefetch>
              <BellIcon />
              {tNotifications('inbox.title')}
              {inbox.count > 0 ? (
                <CountBadge
                  className="ml-auto"
                  count={inbox.count}
                  tone={inbox.needsYou ? 'waiting' : 'neutral'}
                  aria-label={tNotifications('inbox.unreadCount', { count: inbox.count })}
                />
              ) : null}
            </Link>
          </DropdownMenuItem>
        ) : null;
      case 'preferences':
        // The person's own settings (Slack's Preferences). The keycap sits on
        // this row because this row is what the keystroke does:
        // `useSettingsKeyboardShortcut` calls the same `openSettings()`.
        return (
          <DropdownMenuItem onSelect={() => openUserSettings('profile')} size="sm">
            <SlidersHorizontalIcon />
            {t('workspace.preferences')}
            <DropdownMenuShortcut>{settingsShortcutLabel()}</DropdownMenuShortcut>
          </DropdownMenuItem>
        );
      case 'leave':
        // Only for a person without Workspace settings, whose Danger zone
        // holds Leave for everyone else. It confirms first.
        return (
          <DropdownMenuItem onSelect={() => deferAfterClose(leave.open)} size="sm">
            <DoorOpenIcon />
            <span className="min-w-0 flex-1 truncate">{tWorkspaceMenu('leave', { name: project?.name ?? '' })}</span>
          </DropdownMenuItem>
        );
      case 'apps':
        // Chrome, the desktop app, your computer, MCP: every way to use
        // Kortix outside this tab. Also where Download app lives once its
        // sidebar row is dismissed.
        return (
          <DropdownMenuItem
            onSelect={() => deferAfterClose(() => useAppsModalStore.getState().setOpen(true))}
            size="sm"
          >
            <PuzzlePieceIcon />
            {t('workspace.appsAndExtensions')}
          </DropdownMenuItem>
        );
      case 'help':
        return <HelpSubmenu onClose={() => setMenuOpen(false)} />;
      case 'logout':
        return (
          <DropdownMenuItem onClick={openLogoutConfirm} size="sm">
            <LogOut />
            {t('workspace.logOut')}
          </DropdownMenuItem>
        );
    }
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                aria-label={
                  inbox.count > 0
                    ? `${tWorkspaces('switch')}. ${tNotifications('inbox.unreadLabel', { count: inbox.count })}`
                    : tWorkspaces('switch')
                }
                className={cn(
                  'group/workspace hover:bg-sidebar-row relative flex cursor-pointer items-center gap-2 rounded-md px-1',
                  'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
                )}
              >
                {/* Until the project resolves, a tile-shaped and a
                    name-shaped skeleton hold the row. The empty gap this
                    replaced left the caret alone in the corner on every hard
                    refresh, which read as a broken control rather than a
                    loading one. Both shapes match the loaded row (`size-6`
                    tile, one line of text), so nothing shifts when it lands. */}
                {/* `glyph` BEFORE `emoji` below, matching EntityAvatar's own
                    precedence. Both are required: a project's icon is a union —
                    an emoji XOR a named glyph — so passing only `emoji` renders
                    a glyph project's chalk INITIAL here, while the projects grid
                    (`projects/project-card.tsx`) and ⌘K
                    (`workspace/command-palette.tsx`) both draw its glyph. The
                    sidebar is where a person looks at their workspace all day,
                    so that gap read as "I picked an icon and nothing changed". */}
                {project ? (
                  <>
                    {/* The Inbox lives in this menu, not in the sidebar. While
                        an unread question, permission request or failure
                        waits, a dot on the tile says "open me"; a plain
                        unread update does not. */}
                    <span className="relative shrink-0">
                      <EntityAvatar
                        label={project.name}
                        glyph={project.icon_glyph}
                        emoji={project.icon}
                        size="sm"
                      />
                      {inbox.needsYou ? (
                        <span
                          data-testid="workspace-inbox-dot"
                          aria-hidden
                          className="bg-kortix-yellow ring-sidebar absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
                        />
                      ) : null}
                    </span>
                    <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
                      {project.name}
                    </span>
                  </>
                ) : (
                  <>
                    <Skeleton className="size-6 shrink-0 rounded-sm py-0" />
                    <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                      <Skeleton className="h-3 w-24 py-0" />
                    </span>
                  </>
                )}

                <CaretUpDownIcon className="text-muted-foreground group-hover/workspace:text-foreground size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="border-foreground/10 w-[16rem] space-y-0.5 overflow-hidden shadow-lg"
            >
              {menuGroups.map((group, index) => (
                <React.Fragment key={group.join('-')}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {group.map((row) => (
                    <React.Fragment key={row}>{renderRow(row)}</React.Fragment>
                  ))}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {/* Siblings of the dropdown, never children — see `useLogoutFlow`. */}
      {logoutDialog}
      {leave.dialog}

      <LocalComputerModal
        projectId={projectId}
        open={computerSetupOpen}
        onOpenChange={setComputerSetupOpen}
      />

    </>
  );
}
