'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { isProjectAdminPath } from '../../internal/layout/project-capability-nav';
import { useWorkspaceSettingsRailStore } from '../../internal/stores/workspace-settings-rail-store';
import { cn } from '../../internal/lib/utils';
import { useUiPathname, useUiSearchParams } from '../../providers/ui-provider';
import { WorkspaceSettingsSidebarNav } from './workspace-settings-sidebar-nav';

/**
 * Workspace settings drills the project sidebar: the main nav (`children`)
 * slides out to the left and the settings nav slides in from the right, with
 * Back in the slot of New session. The route is the state, so a reload or a
 * shared link opens the panel already drilled, with no slide.
 *
 * This is the only part of the sidebar that reads the route. `children` is
 * created by the parent, so a navigation re-renders these two layers and not
 * the sidebar's nav, switcher or session list.
 *
 * Two layers, one on screen, crossfading with a short directional shift:
 * the settings nav arrives from 22px to the right, the main nav leaves 22px
 * to the left (reversed on Back). Never a full-width slide: text that travels
 * across the column while it fades is text the eye has to chase (motion.md:
 * no opacity with a large translate). The house curve `ease-default` starts
 * fast, so the swap answers the click at once. The leaving layer takes 150ms,
 * the arriving one 200ms: an exit runs at ~75% of the enter. Reduced motion
 * keeps the fade and drops the shift. The hidden layer is inert. The main
 * layer stays mounted: the session list keeps its scroll and open groups.
 */
/**
 * Records where the sidebar's Back row returns to: the last page of this
 * project outside settings. Moving between settings sections never changes
 * it, so Back leaves settings in one click however many sections were opened.
 * Mounted outside `<Sidebar>`: on mobile the sheet unmounts its content while
 * closed, and a navigation then must still be recorded.
 */
export function SettingsReturnTracker({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const search = useUiSearchParams().toString();
  const setReturnTo = useWorkspaceSettingsRailStore((s) => s.setReturnTo);
  useEffect(() => {
    // A project switch can commit the new id before the new path.
    if (isProjectAdminPath(pathname) || !pathname?.includes(`/${projectId}`)) return;
    setReturnTo(projectId, search ? `${pathname}?${search}` : pathname);
  }, [pathname, search, projectId, setReturnTo]);
  return null;
}

export function SidebarDrill({
  projectId,
  onNavigate,
  children,
}: {
  projectId: string;
  /** Called after a click in the settings nav (mobile closes the sheet). */
  onNavigate: () => void;
  children: ReactNode;
}) {
  const pathname = useUiPathname();
  // The swap starts on the click, not when the route commits. The route can
  // take a few hundred milliseconds to load, and a swap that waits for it
  // reads as unrelated to the click, then runs while the settings page
  // mounts and drops frames. `intent` is the click's answer, held until the
  // path changes; a click that opens a new tab (modifier keys, middle
  // button) is not a drill.
  const [intent, setIntent] = useState<{ at: string; drilled: boolean } | null>(null);
  const drilled = intent && intent.at === pathname ? intent.drilled : isProjectAdminPath(pathname);
  const drillOnClick = (to: boolean) => (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as HTMLElement).closest('a[href]');
    if (!link || (link as HTMLAnchorElement).target === '_blank') return;
    const href = link.getAttribute('href') ?? '';
    if (isProjectAdminPath(href) !== to) return;
    setIntent({ at: pathname, drilled: to });
  };

  // A keyboard-driven swap is instant (motion.md: never animate a keyboard
  // action). The last input decides, written to the DOM so no render waits
  // on it. A route change with no input of its own (browser Back, a swipe)
  // follows the last input too, so after typing it is instant. The keyboard
  // swap also moves focus into the new layer, since the link that had it is
  // now inert.
  const mainLayerRef = useRef<HTMLDivElement>(null);
  const settingsLayerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = (instant: boolean) => () => {
      for (const layer of [mainLayerRef.current, settingsLayerRef.current]) {
        if (instant) layer?.setAttribute('data-instant', '');
        else layer?.removeAttribute('data-instant');
      }
    };
    const onKey = mark(true);
    const onPointer = mark(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
  const previousDrilled = useRef(drilled);
  useEffect(() => {
    if (previousDrilled.current === drilled) return;
    previousDrilled.current = drilled;
    const incoming = drilled ? settingsLayerRef.current : mainLayerRef.current;
    const outgoing = drilled ? mainLayerRef.current : settingsLayerRef.current;
    if (!incoming?.hasAttribute('data-instant')) return;
    const active = document.activeElement;
    if (active && active !== document.body && !outgoing?.contains(active)) return;
    incoming.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
  }, [drilled]);

  return (
    <>
      {/* `will-change` gives each layer its own compositor layer, so the
          swap keeps its frames while the main thread mounts the next page. */}
      <div
        ref={mainLayerRef}
        inert={drilled}
        onClickCapture={drillOnClick(true)}
        className={cn(
          'flex h-full min-h-0 flex-col space-y-2 transition-[translate,opacity] ease-default will-change-[translate,opacity] data-instant:transition-none',
          drilled ? 'pointer-events-none opacity-0 duration-normal motion-safe:-translate-x-6' : 'duration-moderate',
        )}
      >
        {children}
      </div>
      <div
        ref={settingsLayerRef}
        inert={!drilled}
        onClickCapture={drillOnClick(false)}
        className={cn(
          'absolute inset-0 transition-[translate,opacity] ease-default will-change-[translate,opacity] data-instant:transition-none',
          drilled ? 'duration-moderate' : 'pointer-events-none opacity-0 duration-normal motion-safe:translate-x-6',
        )}
      >
        <WorkspaceSettingsSidebarNav projectId={projectId} shown={drilled} onNavigate={onNavigate} />
      </div>
    </>
  );
}
