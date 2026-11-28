'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { DotsThreeIcon, MagnifyingGlassIcon, PushPinSlashIcon, StackIcon } from '@phosphor-icons/react';
import { useState, type MouseEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { SidebarGlyph as PanelLeft } from '../../icons/sidebar-toggle';
import { Home } from '../../internal/icons/home';
import { CustomizeGlyph, useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { adminPath, uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../primitives/context-menu';
import Hint from '../../primitives/hint';
import { Kbd, KbdGroup } from '../../primitives/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { SidebarMenu, useSidebar } from '../../primitives/sidebar';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { ProjectNavItems } from './project-nav-items';
import { PinnedRailItem, useRailPins } from './rail-pins';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modSymbol = isMac ? '⌘' : 'Ctrl';
/** Every rail control: Button size `icon-base` (`size-8`), `rounded-md`, with a ~17px glyph (`size-4.5`). */
// `!`: Button's own `[&_svg:not([class*='size-'])]:size-4` is more specific and kept every
// Phosphor glyph at its own size while Home (which carries a size class) took ours.
const RAIL_CONTROL = 'shrink-0 rounded-md [&_svg]:size-4.5!';

/**
 * The project's icon rail (desktop, flag `sidebar_rail`): fixed at the
 * window's left edge beside the sidebar panel, on screen whether the panel is
 * open or not.
 *
 * Top: Home (the panel's sessions), Search (the command palette), Spaces
 * (`session_groups`), the pages pinned from More (each More row has a pin;
 * kept per workspace in this browser; right-click or double-click one to hide
 * it), then More (a menu of every other page: Review, Drive, Apps, Calendar,
 * Goals, Artifacts; with `chat` on, Review stays first in the Spaces list).
 * Bottom: Help, Customize (workspace settings), and the panel toggle. The
 * toggle hides the panel, never the rail.
 *
 * With the panel collapsed, hovering Home shows the panel on the sessions,
 * hovering Spaces on the spaces, and hovering Customize on the workspace
 * settings list, wherever the page is (the sidebar's peek, the same hover
 * intent as the edge strip it replaces).
 */
export function ProjectRail({
  projectId,
  onOpenSearch,
  help,
  settingsOpen,
  onPeek,
}: {
  projectId: string;
  /** With the panel collapsed, a hover on Home, Spaces or Customize shows the panel on that list. */
  onPeek: (section: 'home' | 'spaces' | 'customize') => void;
  onOpenSearch?: () => void;
  /** The help menu's own icon trigger (apps/web passes `HelpMenu`). */
  help?: ReactNode;
  /** The route is workspace settings: Customize is the current item. */
  settingsOpen: boolean;
}) {
  const t = useTranslations('sidebar');
  const tRail = useTranslations('sidebar.iconRail');
  const tGroups = useTranslations('sidebar.sessionGroups');
  const { state, toggleSidebar, peekEnter, peekLeave } = useSidebar();
  const pathname = useUiPathname();
  const collapsed = state === 'collapsed';
  const [moreOpen, setMoreOpen] = useState(false);
  const railPins = useRailPins(projectId);

  const groupsOn = useFeatureFlag(projectId, 'session_groups').enabled;
  const spacesHref = groupsOn ? (uiRoutes().sessionSpaces?.(projectId) ?? null) : null;
  const onSpaces = !!spacesHref && !!pathname && (pathname === spacesHref || pathname.startsWith(`${spacesHref}/`));
  // `chat` on: Review is the first row of the panel's Spaces list, so More leaves it out.
  const chat = useFeatureFlag(projectId, 'chat').enabled;

  const access = useCapabilityAccess(projectId);
  const customizeHref =
    access.settled && access.tabs.length > 0
      ? access.tabs.includes('agent')
        ? adminPath(projectId, 'agents')
        : adminPath(projectId)
      : null;

  return (
    <nav aria-label={tRail('navigation')} className="flex h-full w-full flex-col items-center gap-1 py-2">
      {/* The desktop app's window controls sit in the top-left band (0 on the web): the rail starts below it. */}
      <div aria-hidden className="h-(--kx-titlebar-inset) shrink-0" />
      <RailButton
        label={tRail('home')}
        href={uiRoutes().project(projectId)}
        current={!settingsOpen && !onSpaces}
        onPointerEnter={collapsed ? () => { onPeek('home'); peekEnter(); } : undefined}
        onPointerLeave={collapsed ? peekLeave : undefined}
      >
        <Home />
      </RailButton>
      {onOpenSearch ? (
        <RailButton
          label={
            <span className="flex items-center gap-1.5">
              {t('search')}
              <KbdGroup>
                <Kbd className="font-mono">{modSymbol}</Kbd>
                <Kbd className="font-mono">K</Kbd>
              </KbdGroup>
            </span>
          }
          ariaLabel={t('search')}
          onClick={onOpenSearch}
        >
          <MagnifyingGlassIcon />
        </RailButton>
      ) : null}
      {spacesHref ? (
        <RailButton
          label={tGroups('heading')}
          href={spacesHref}
          current={onSpaces}
          onPointerEnter={collapsed ? () => { onPeek('spaces'); peekEnter(); } : undefined}
          onPointerLeave={collapsed ? peekLeave : undefined}
        >
          <StackIcon />
        </RailButton>
      ) : null}
      {/* The pages pinned from More, above it, in pin order. Right-click or
          double-click one for Hide tab. A page this workspace stops offering drops out. */}
      {railPins.pins.map((id) => (
        <PinnedRailItem
          key={id}
          projectId={projectId}
          id={id}
          render={(page, current) => (
            <ContextMenu>
              <ContextMenuTrigger
                asChild
                onDoubleClick={(event) => {
                  // A double-click opens the same menu, at the pointer.
                  event.currentTarget.dispatchEvent(
                    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }),
                  );
                }}
              >
                <span className="flex">
                  <RailButton label={page.label} href={page.href} current={current}>
                    {page.icon}
                  </RailButton>
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => railPins.toggle(id)}>
                  <PushPinSlashIcon />
                  {tRail('unpinTab')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}
        />
      ))}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <Hint side="right" alignOffset={0} label={tRail('more')}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-base"
              aria-label={tRail('more')}
              className={cn(RAIL_CONTROL, 'text-muted-foreground hover:text-foreground', moreOpen && 'bg-sidebar-accent text-foreground')}
            >
              <DotsThreeIcon weight="bold" />
            </Button>
          </PopoverTrigger>
        </Hint>
        {/* Every other page, each row with its own flag and permission gate; Apps keeps its hover card.
            No counts here. */}
        <PopoverContent side="right" align="start" className="w-56 p-1" onClick={() => setMoreOpen(false)}>
          <SidebarMenu>
            <ProjectNavItems projectId={projectId} review={!chat} customize={false} pin={railPins} counts={false} />
          </SidebarMenu>
        </PopoverContent>
      </Popover>

      <div className="mt-auto flex flex-col items-center gap-1">
        {/* The help menu brings its own trigger: sized here to match the rail. */}
        {help ? <div className="[&_button]:size-8 [&_button]:rounded-md [&_svg]:size-4.5!">{help}</div> : null}
        {customizeHref ? (
          <RailButton
            label={t('customize')}
            href={customizeHref}
            current={settingsOpen}
            onPointerEnter={collapsed ? () => { onPeek('customize'); peekEnter(); } : undefined}
            onPointerLeave={collapsed ? peekLeave : undefined}
          >
            <CustomizeGlyph />
          </RailButton>
        ) : null}
        <RailButton
          label={
            <span className="flex items-center gap-1.5">
              {collapsed ? t('pin') : t('collapse')}
              <KbdGroup>
                <Kbd className="font-mono">{modSymbol}</Kbd>
                <Kbd className="font-mono">B</Kbd>
              </KbdGroup>
            </span>
          }
          ariaLabel={collapsed ? t('pin') : t('collapse')}
          onClick={toggleSidebar}
        >
          <PanelLeft className="cn-rtl-flip" />
        </RailButton>
      </div>
    </nav>
  );
}

/**
 * One rail control: an `icon-base` button, or a link when `href` is set, with its
 * name in a hint on the right. Hover changes color only.
 */
function RailButton({
  label,
  ariaLabel,
  href,
  current,
  onClick,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  label: ReactNode;
  /** Required when `label` is not plain text. */
  ariaLabel?: string;
  href?: string | null;
  current?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: ReactNode;
}) {
  const name = ariaLabel ?? (typeof label === 'string' ? label : undefined);
  const className = cn(RAIL_CONTROL, 'text-muted-foreground hover:text-foreground', current && 'bg-sidebar-accent text-foreground');
  return (
    <Hint side="right" alignOffset={0} label={label}>
      {href ? (
        <Button asChild variant="ghost" size="icon-base" className={className}>
          <Link
            href={href}
            prefetch
            aria-label={name}
            aria-current={current ? 'page' : undefined}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
          >
            {children}
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-base"
          aria-label={name}
          aria-current={current ? 'page' : undefined}
          onClick={onClick}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          className={className}
        >
          {children}
        </Button>
      )}
    </Hint>
  );
}
