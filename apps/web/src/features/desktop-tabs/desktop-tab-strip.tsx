'use client';

import Hint from '@kortix/ui/hint';

import { useCachedWorkspaceSessions } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@kortix/ui/context-menu';
import { Kbd, KbdGroup } from '@kortix/ui/kbd';
import { useSessionNeedsYouCounts, useSessionsAwaitingAnswer } from '@kortix/ui/internal/hooks/use-review-session-summary';
import { useSidebar } from '@kortix/ui/sidebar';
import { CardsThreeIcon, PlusIcon, PushPinIcon, PushPinSlashIcon, XIcon } from '@phosphor-icons/react';
import { Reorder } from 'motion/react';
import { usePathname } from 'next/navigation';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from '@/i18n/use-translations';
import { EMPTY_PROJECT_TABS, reorder, useDesktopTabsStore, type DesktopTab } from './desktop-tabs-store';
import { stripVisible, tabRoute } from './tab-route';
import { TabLabel, SessionSignalsProvider } from './desktop-tab-label';
import { useDesktopTabNavigation } from './use-desktop-tab-navigation';
export { TabLabel } from './desktop-tab-label';

/* ─── Strip ───────────────────────────────────────────────────────────────── */

/**
 * Tabs do not animate: they open, close and switch in the frame you act in.
 * The one motion is a short slide while you drag a tab to a new place, so the
 * tabs it passes move aside instead of jumping under the pointer.
 */
const DRAG_SHIFT = { duration: 0.15, ease: 'easeOut' } as const;
const NO_MOTION = { duration: 0 } as const;

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * The desktop window's tab strip: browser tabs for the project's pages.
 *
 * It sits in the title-bar band, right of the traffic lights (or right of the
 * sidebar when the sidebar is open), and every project page renders below it.
 * A tab follows navigation; the sidebar moves the active tab, `+` and Mod+T
 * open a new one on the project home. Rendered by the project shell on the
 * desktop shell only — the web keeps the browser's own tabs.
 *
 * Cost: one zustand subscription for the list; session titles from the
 * session caches the sidebar already fills (`useCachedWorkspaceSessions`, a
 * request only for a session in no cache); one cached read per artifact tab;
 * no subscriber inside the page tree. A tab switch re-renders the strip and
 * the route, nothing else.
 */
/**
 * Whether the strip shows, for the shell: the same synchronous rule the strip
 * uses (`stripVisible`), from the store and the current path, so the shell's
 * title-band layout and the strip switch in the same render and never flicker.
 */
export function useDesktopTabsVisible(projectId: string): boolean {
  const path = usePathname() ?? '';
  const tabs = useDesktopTabsStore((s) => s.byProject[projectId]?.tabs ?? EMPTY_PROJECT_TABS.tabs);
  return stripVisible(tabs, path, projectId);
}

export function DesktopTabStrip({ projectId }: { projectId: string }) {
  const t = useTranslations('desktopTabs');
  const { pathname, activate, close, openNew, reopen, newToRight, duplicate, keep, pin, closeOthersOf, closeRightOf } = useDesktopTabNavigation(projectId);
  const { state: sidebarState, isMobile } = useSidebar();
  const collapsed = isMobile || sidebarState === 'collapsed';
  const project = useDesktopTabsStore((s) => s.byProject[projectId] ?? EMPTY_PROJECT_TABS);
  const update = useDesktopTabsStore((s) => s.update);

  // Only while a tab is being dragged do the others move with a slide.
  const [dragging, setDragging] = useState(false);

  const sessionIds = project.tabs
    .map((tab) => tabRoute(tab.path, projectId))
    .flatMap((route) => (route?.kind === 'session' ? [route.sessionId] : []));
  // The sidebar's own rows (SDK cache read): same title and status, no request.
  const rows = useCachedWorkspaceSessions(projectId, sessionIds);
  const needsYou = useSessionNeedsYouCounts(projectId);
  const awaitingAnswer = useSessionsAwaitingAnswer(projectId);
  const signals = useMemo(
    () => ({ rows, needsYou, awaitingAnswer }),
    [rows, needsYou, awaitingAnswer],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;
    e.preventDefault();
    items[(idx + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const mod = isMac() ? '⌘' : 'Ctrl';

  // The strip's height, for views sized to the window (globals.css): it is
  // one band row, but its height differs per platform and in fullscreen.
  const stripRef = useRef<HTMLDivElement>(null);
  const shown = stripVisible(project.tabs, pathname, projectId);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    const write = () =>
      root.style.setProperty('--kx-desktop-tabstrip-height', `${el.offsetHeight}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--kx-desktop-tabstrip-height');
    };
  }, [shown]);

  // Hidden (a fresh start): stays mounted, so the tabs keep following the
  // window, but draws nothing and leaves the title band to the page.
  if (!shown) return null;

  return (
    <div
      ref={stripRef}
      data-kx-desktop-tabs=""
      data-sidebar-collapsed={collapsed ? '' : undefined}
      // `.kx-titlebar-row` + `.kx-titlebar-band-height`: the strip IS the band
      // row — drag region, no-drag controls, the collapsed-sidebar indent past
      // the shell's toggle and the macOS light-centred height (globals.css).
      className="kx-desktop-tabstrip kx-titlebar-row kx-titlebar-band-height bg-sidebar border-border flex h-10 shrink-0 items-center gap-1 border-b px-2"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('tabs')}
        onKeyDown={onListKeyDown}
        className="flex min-w-0 flex-1 items-center"
      >
        <Reorder.Group
          as="div"
          axis="x"
          values={project.tabs.map((tab) => tab.id)}
          onReorder={(ids: string[]) => update(projectId, (s) => reorder(s, ids))}
          // Never scrolls: every tab shrinks to share the width, down to its
          // icon and then less, the way a browser's tabs do. The active tab
          // keeps room for its title and close button.
          // `px-px`: room for the active tab's 1px ring, which `overflow-hidden`
          // would otherwise clip at the strip's first and last tab.
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-px py-1"
        >
          <SessionSignalsProvider value={signals}>
            {project.tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                projectId={projectId}
                active={tab.id === project.activeId}
                dragging={dragging}
                onDragging={setDragging}
                onActivate={activate}
                onKeep={keep}
                onClose={close}
                onNewToRight={newToRight}
                onDuplicate={duplicate}
                onPin={pin}
                onCloseOthers={closeOthersOf}
                onCloseToRight={closeRightOf}
                canReopen={project.closed.length > 0}
                onReopen={reopen}
                mod={mod}
                t={t}
              />
            ))}
          </SessionSignalsProvider>
          {/* Right after the last tab. */}
          <div className="shrink-0">
            <Hint
              side="bottom"
              label={
                <span className="flex items-center gap-2">
                  {t('newTab')}
                  <Keys keys={[mod, 'T']} />
                </span>
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('newTab')}
                onClick={() => openNew()}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <PlusIcon className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          </div>
        </Reorder.Group>
      </div>
    </div>
  );
}

/* ─── One tab ─────────────────────────────────────────────────────────────── */

type Translate = ReturnType<typeof useTranslations>;

interface TabItemProps {
  tab: DesktopTab;
  projectId: string;
  active: boolean;
  /** Some tab is being dragged: tabs slide aside instead of jumping. */
  dragging: boolean;
  onDragging: (dragging: boolean) => void;
  onActivate: (id: string) => void;
  /** The preview tab becomes a normal tab. */
  onKeep: (id: string) => void;
  onClose: (id: string) => void;
  onNewToRight: (id: string) => void;
  onDuplicate: (id: string, path: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  canReopen: boolean;
  onReopen: () => void;
  mod: string;
  t: Translate;
}

const TabItem = memo(function TabItem({
  tab,
  projectId,
  active,
  dragging,
  onDragging,
  onActivate,
  onKeep,
  onClose,
  onNewToRight,
  onDuplicate,
  onPin,
  onCloseOthers,
  onCloseToRight,
  canReopen,
  onReopen,
  mod,
  t,
}: TabItemProps) {
  const route = tabRoute(tab.path, projectId);
  const pinned = !!tab.pinned;

  return (
    <Reorder.Item
      as="div"
      value={tab.id}
      layout="position"
      transition={dragging ? DRAG_SHIFT : NO_MOTION}
      onDragStart={() => {
        onDragging(true);
        // Moving a tab is choosing to keep it.
        onKeep(tab.id);
      }}
      onDragEnd={() => onDragging(false)}
      whileDrag={{ zIndex: 1 }}
      className={cn(
        'relative min-w-0',
        pinned ? 'shrink-0' : 'flex-[0_1_12.5rem]',
        // The active tab keeps room for its title and close button.
        !pinned && (active ? 'min-w-24' : 'min-w-0'),
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            data-active={active ? '' : undefined}
            onPointerDown={(e) => {
              // Activate on press, like a browser tab: the page starts loading
              // before the button comes back up.
              if (e.button !== 0 || e.ctrlKey) return;
              if (!active) onActivate(tab.id);
            }}
            // Double-click keeps the preview tab, like an editor's.
            onDoubleClick={() => onKeep(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1 && !pinned) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate(tab.id);
              }
            }}
            className={cn(
              'group/tab @container flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm text-xs select-none',
              'outline-none',
              // Only hover fades: losing or gaining selection is one step.
              active
                ? 'transition-none'
                : 'hover:duration-fast transition-none hover:transition-colors hover:ease-out',
              'focus-visible:ring-ring focus-visible:ring-2',
              pinned ? 'w-8 justify-center px-0' : 'pr-1 pl-2',
              active
                ? 'bg-popover text-foreground ring-border shadow-xs ring-1'
                : 'bg-hover text-muted-foreground hover:bg-active hover:text-foreground',
            )}
          >
            <TabLabel
              route={route}
              projectId={projectId}
              pinned={pinned}
              preview={!!tab.preview}
              t={t}
            />
            {!pinned && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('closeTab')}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  // `bg-hover` is translucent, so it reads one step above the
                  // tab's own hover fill underneath.
                  'text-muted-foreground hover:text-foreground hover:bg-hover flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[calc(var(--radius)-6px)]',
                  'duration-fast transition-[opacity,color,background-color] ease-out',
                  // Hidden (not removed) when idle: hover never shifts the title.
                  active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
                  // Too narrow for a title and a close button: the tab is its icon.
                  !active && '@max-[4.5rem]:hidden',
                )}
              >
                <XIcon className="size-3 shrink-0" />
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <ContextMenuItem onClick={() => onNewToRight(tab.id)}>
            <PlusIcon />
            {t('newTabToRight')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onDuplicate(tab.id, tab.path)}>
            <CardsThreeIcon />
            {t('duplicate')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onPin(tab.id, !pinned)}>
            {pinned ? <PushPinSlashIcon /> : <PushPinIcon />}
            {pinned ? t('unpin') : t('pin')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onClose(tab.id)}>
            <XIcon />
            {t('closeTab')}
            <ContextMenuShortcut>
              <Keys keys={[mod, 'W']} />
            </ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem inset onClick={() => onCloseOthers(tab.id)}>
            {t('closeOthers')}
          </ContextMenuItem>
          <ContextMenuItem inset onClick={() => onCloseToRight(tab.id)}>
            {t('closeToRight')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem inset disabled={!canReopen} onClick={onReopen}>
            {t('reopenClosed')}
            <ContextMenuShortcut>
              <Keys keys={['⇧', mod, 'T']} />
            </ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  );
});

/** A key combination, one `Kbd` per key. `Ctrl` is wider than one glyph. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key} className={key.length > 1 ? 'w-auto' : undefined}>
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}
