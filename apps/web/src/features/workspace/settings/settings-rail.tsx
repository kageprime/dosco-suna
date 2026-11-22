'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeftIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';

import { Avatar, AvatarFallback, AvatarImage } from '@kortix/ui/avatar';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { FadedScrollArea } from '@kortix/ui/faded-scroll-area';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { ModalClose } from '@kortix/ui/modal';
import { TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { workspaceAccountLabel } from '@kortix/ui/workspace/sidebar/workspace-grouping';
import { cn } from '@kortix/ui';
import { hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import type { SettingsRailChromeCopy } from '@kortix/ui/customize/settings/rail-copy-context';
import type { RailGroup } from '@kortix/ui/customize/settings/type';
import {
  accountRoleLabel,
  type AccountMembership,
  type AccountMembershipsCopy,
} from './tabs/account-memberships';
import { profileInitials, type ProfileIdentity } from './tabs/profile-query';

/**
 * The rows draw with the project sidebar's menu-button recipe
 * (`sidebar-menu-primitives.tsx`: 32px tall, `px-2`, medium label, full ink,
 * `bg-hover` / `bg-active`), so Preferences and Workspace settings read as one
 * sidebar. The rows stay `Tabs` triggers here: the panes are tabs, not routes.
 */
const ROW_CLASS =
  'flex h-8 w-full items-center justify-start gap-2 rounded-md px-2 text-sm font-medium text-sidebar-foreground outline-none hover:bg-hover active:bg-active focus-visible:ring-[0.6px] focus-visible:ring-kortix-base [&_svg]:size-4 [&_svg]:shrink-0';

const GROUP_LABEL_CLASS = 'text-sidebar-foreground/70 flex h-8 items-center px-2 text-xs font-medium';

function matches(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query);
}

function RailNav({
  groups,
  showGroupLabels,
  organizations,
  organizationCopy,
  chrome,
  onPick,
  className,
  autoFocusSearch = false,
}: {
  groups: readonly RailGroup[];
  showGroupLabels: boolean;
  organizations: readonly AccountMembership[];
  organizationCopy: AccountMembershipsCopy;
  chrome: SettingsRailChromeCopy;
  onPick?: () => void;
  className?: string;
  /** Desktop: opening Preferences puts the cursor in the search field, as
   *  Workspace settings does. Not on a phone: the keyboard covers the list. */
  autoFocusSearch?: boolean;
}) {
  const [query, setQuery] = useState('');
  // `useIsMobile` reads false on a cold phone open, so the desktop rail can
  // mount for a frame there. The viewport at mount decides focus instead
  // (768px: `MOBILE_BREAKPOINT` in `packages/ui/src/hooks/use-mobile.ts`).
  const [desktopAtMount] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  const navRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLocaleLowerCase();

  const shownGroups = useMemo(
    () =>
      needle
        ? groups
            .map((group) => ({ ...group, items: group.items.filter((item) => matches(item.label, needle)) }))
            .filter((group) => group.items.length > 0)
        : groups,
    [groups, needle],
  );
  const shownOrganizations = useMemo(
    () =>
      needle
        ? organizations.filter((account) =>
            matches(workspaceAccountLabel(account.name, organizationCopy.fallbackAccountName, false), needle),
          )
        : organizations,
    [organizations, organizationCopy.fallbackAccountName, needle],
  );
  const empty = needle && shownGroups.length === 0 && shownOrganizations.length === 0;

  // Enter opens the first row left by the filter; Escape empties the field
  // (the dialog leaves Escape in a text field to the field).
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME confirming or cancelling text owns Enter and Escape.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    } else if (event.key === 'Enter' && needle) {
      event.preventDefault();
      navRef.current?.querySelector<HTMLElement>('[role="tab"], a[href]')?.click();
    }
  };

  return (
    <>
      <div className="shrink-0 px-2 pb-2">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            type="text"
            size="xs"
            className="pr-9 text-sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            ref={inputRef}
            autoFocus={autoFocusSearch && desktopAtMount}
            onKeyDown={onKeyDown}
            // The dialog's Escape guard reads this: an empty field lets Escape close Preferences.
            data-settings-search=""
            placeholder={chrome.search}
            aria-label={chrome.search}
          />
          {query ? (
            <InputGroupSearchClear
              className="opacity-100"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            />
          ) : null}
        </InputGroupSearch>
      </div>

      {/* No scrollbar, so a fade marks the edge that hides rows, as in the
          Workspace settings sidebar. */}
      <FadedScrollArea rootClassName={cn('min-h-0 flex-1', className)} fadeSize="8" fadeColor="from-surface" className="isolate">
      <nav ref={navRef} aria-label={chrome.settings} className="flex flex-col gap-2 px-2 pt-1 pb-2">
        {empty ? (
          <p role="status" className="text-muted-foreground px-2 py-2 text-sm">
            {chrome.searchNoResults}
          </p>
        ) : null}

        {shownGroups.map((group) => (
          <div key={group.label}>
            {showGroupLabels ? <div className={GROUP_LABEL_CLASS}>{group.label}</div> : null}
            <TabsList orientation="vertical" className="w-full gap-px">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <TabsTrigger
                    key={item.tab}
                    value={item.tab}
                    // Runs on every tap, so mobile opens the pane even for the row
                    // already selected (`Tabs` fires no value change for it).
                    onClick={onPick}
                    className={cn(
                      ROW_CLASS,
                      // Beat the trigger's own icon padding and inactive hover ink.
                      'flex-none border-0 transition-none has-[>svg]:px-2',
                      'data-[state=inactive]:text-sidebar-foreground data-[state=inactive]:hover:bg-hover data-[state=inactive]:hover:text-sidebar-foreground',
                      'data-[state=active]:bg-active data-[state=active]:text-sidebar-foreground',
                    )}
                  >
                    {Icon ? <Icon /> : null}
                    <span className="truncate">{item.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
        ))}

        {shownOrganizations.length > 0 ? (
          /* The workspaces the person belongs to. Each row LEAVES the overlay
             for that workspace's own settings — members, billing, roles and
             audit live there — so it is a link that closes the dialog, not a
             tab. One line per row, the role trailing, so the list keeps the
             tab rows' rhythm above it. */
          <div>
            <div className={GROUP_LABEL_CLASS}>{organizationCopy.title}</div>
            <ul className="flex flex-col gap-px">
              {shownOrganizations.map((account) => {
                const role = accountRoleLabel(account.account_role, organizationCopy);
                const name = workspaceAccountLabel(account.name, organizationCopy.fallbackAccountName, false);
                const body = (
                  <>
                    {/* The switcher's tile. 20px against the rows' 16px glyphs:
                        `-mx-0.5` keeps its centre and the label on their columns. */}
                    <EntityAvatar
                      label={name}
                      glyph={account.icon_glyph}
                      emoji={account.icon}
                      size="xs"
                      className="-mx-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {role ? <span className="text-muted-foreground shrink-0 text-xs font-normal">{role}</span> : null}
                  </>
                );
                return (
                  <li key={account.workspace_id ?? account.account_id}>
                    {/* A workspace row opens that workspace's settings. It closes
                        the panel with its destination: on /settings, a plain
                        close would send the route back to the last workspace. */}
                    {account.workspace_id ? (
                      <Link
                        href={`/workspaces/${account.workspace_id}/admin`}
                        className={ROW_CLASS}
                        onClick={() =>
                          useSettingsPanelStore.getState().closeTo(`/workspaces/${account.workspace_id}/admin`)
                        }
                      >
                        {body}
                      </Link>
                    ) : (
                      <ModalClose asChild>
                        <HubLink to={hubTarget(account.account_id)} className={ROW_CLASS}>
                          {body}
                        </HubLink>
                      </ModalClose>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </nav>
      </FadedScrollArea>
    </>
  );
}

/**
 * The header band: who these preferences belong to, in the slot where the
 * project sidebar shows the workspace. Blank while the profile loads, so the
 * band never jumps.
 */
function IdentityHeader({ identity }: { identity: ProfileIdentity | undefined }) {
  return (
    <div className="kx-titlebar-row kx-titlebar-band-height kx-overlay-sidebar-titlebar flex h-11 shrink-0 items-center justify-start! px-2">
      {identity ? (
        <div className="flex min-w-0 items-center gap-2 px-1">
          <Avatar className="size-6 shrink-0 rounded-full">
            {identity.avatarUrl ? <AvatarImage src={identity.avatarUrl} alt="" /> : null}
            <AvatarFallback className="text-xs">{profileInitials(identity.name)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">{identity.name}</span>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsRail({
  isMobile,
  mobilePane,
  railProps,
  identity,
  closeButton,
  onPick,
}: {
  isMobile: boolean;
  mobilePane: boolean;
  railProps: React.ComponentProps<typeof RailNav>;
  identity?: ProfileIdentity;
  closeButton: React.ReactNode;
  onPick: () => void;
}) {
  const chrome = railProps.chrome;
  return isMobile ? (
    /* Mobile is two screens, like a phone's Settings app: this list,
             then the picked pane with a back pill (in <main> below). The old
             tab strip clipped every label past the third at phone width. */
    mobilePane ? null : (
      <div className="flex min-h-0 flex-1 flex-col bg-inherit">
        <header
          className="kx-titlebar-row kx-titlebar-band-height kx-settings-mobile-titlebar mb-2 flex h-11 shrink-0 items-center justify-between border-b px-2"
          data-sidebar-collapsed=""
        >
          <span className="px-2 text-sm font-medium">{chrome.settings}</span>
          {closeButton}
        </header>
        <RailNav {...railProps} onPick={onPick} />
      </div>
    )
  ) : (
    /* The project sidebar drilled into Workspace settings
       (`workspace-settings-sidebar-nav.tsx`), for the person: the header band,
       a Back row, the search field, then the groups. */
    <aside className="flex min-h-0 flex-col border-r bg-inherit">
      <IdentityHeader identity={identity} />
      <div className="shrink-0 px-2 pb-2">
        <ModalClose asChild>
          <button type="button" className={ROW_CLASS}>
            <ArrowLeftIcon className="cn-rtl-flip" />
            <span>{chrome.backToApp}</span>
          </button>
        </ModalClose>
      </div>
      <RailNav {...railProps} autoFocusSearch />
    </aside>
  );
}
