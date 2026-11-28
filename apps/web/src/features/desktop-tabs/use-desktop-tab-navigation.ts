'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { MOUNTED_ATTRIBUTE, SETTINGS_ENTRY_ATTRIBUTE } from './desktop-tabs-gate';
import { closeOthers, closeTab, closeToRight, EMPTY_PROJECT_TABS, keepTab, openBlankTab, openTab, readProjectTabs, reopenClosed, setPinned, syncPath, useDesktopTabsStore } from './desktop-tabs-store';
import { newTabPath, isSettingsGroup, pathGroup, tabRoute } from './tab-route';
const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export function useDesktopTabNavigation(projectId: string) {
  const router = useRouter();
  // A tab's location is the path WITH its query: Drive keeps the folder in
  // `?path=`, so a tab must come back to that folder, not the Drive root.
  const path = usePathname() ?? '';
  const search = useSearchParams()?.toString() ?? '';
  const pathname = search ? `${path}?${search}` : path;
  const project = useDesktopTabsStore((s) => s.byProject[projectId] ?? EMPTY_PROJECT_TABS);
  const update = useDesktopTabsStore((s) => s.update);

  // A link click whose page has not arrived yet. When the person switches or
  // opens a tab before it lands, that navigation belongs to the tab it started
  // in, not to the tab now in front — the browser rule. `inFlight` is the
  // pending link; `handoff` is the tab switch that overtook it.
  // How the window got to its current address: a pushed entry (a click) or a
  // replaced one (a redirect). The Navigation API reports it as the history
  // call is made, before React commits the new path. Only a change of path
  // counts: Next also replaces the entry in place to save its own state.
  const lastNavigation = useRef<{ type: string; path: string } | null>(null);
  useEffect(() => {
    const navigation = (window as { navigation?: EventTarget }).navigation;
    if (!navigation) return;
    const onNavigate = (event: Event) => {
      const { navigationType, destination } = event as Event & {
        navigationType?: string;
        destination?: { url?: string };
      };
      if (!destination?.url) return;
      const to = new URL(destination.url, window.location.href).pathname;
      if (to === window.location.pathname) return;
      lastNavigation.current = { type: navigationType ?? 'push', path: to };
    };
    navigation.addEventListener('navigate', onNavigate);
    return () => navigation.removeEventListener('navigate', onNavigate);
  }, []);

  const inFlight = useRef<string | null>(null);
  const handoff = useRef<{ stalePath: string; fromId: string | null; toPath: string } | null>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.origin !== window.location.origin)
        return;
      const target = `${anchor.pathname}${anchor.search}`;
      if (target !== `${window.location.pathname}${window.location.search}`) {
        inFlight.current = target;
      }
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);

  // ⌘-click (Ctrl-click) or middle-click on a link to a page of this project:
  // a new tab in the background, the way a browser does it. Without this the
  // shell would hand the link to a new window or the system browser.
  useEffect(() => {
    const onOpenInBackground = (e: MouseEvent) => {
      const middle = e.type === 'auxclick' && e.button === 1;
      const modified = e.type === 'click' && e.button === 0 && (e.metaKey || e.ctrlKey);
      if (!middle && !modified) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.origin !== window.location.origin)
        return;
      const target = `${anchor.pathname}${anchor.search}`;
      if (!tabRoute(target, projectId)) return;
      e.preventDefault();
      e.stopPropagation();
      update(projectId, (s) => openTab(s, target, null, true));
      router.prefetch(target);
    };
    document.addEventListener('click', onOpenInBackground, { capture: true });
    document.addEventListener('auxclick', onOpenInBackground, { capture: true });
    return () => {
      document.removeEventListener('click', onOpenInBackground, { capture: true });
      document.removeEventListener('auxclick', onOpenInBackground, { capture: true });
    };
  }, [projectId, router, update]);

  // The window moved: the active tab follows it, or the tab already there
  // takes focus. Paths outside this project (a full-screen frame) are ignored.
  useEffect(() => {
    const late = handoff.current;
    if (late && pathname === late.stalePath) {
      // The overtaken link landed: give it to its own tab, then put the front
      // tab's page back.
      handoff.current = null;
      inFlight.current = null;
      if (late.fromId && tabRoute(pathname, projectId)) {
        update(projectId, (s) => ({
          ...s,
          tabs: s.tabs.map((tab) => (tab.id === late.fromId ? { ...tab, path: pathname } : tab)),
        }));
      }
      router.replace(late.toPath);
      return;
    }
    // Any arrival settles the pending link: it landed, or a newer one won.
    inFlight.current = null;
    if (!tabRoute(pathname, projectId)) return;
    // A redirect (the page replaced its own address) belongs to the tab it
    // happened in; a click (a pushed entry) goes through the tab rules.
    const redirect = lastNavigation.current;
    lastNavigation.current = null;
    const replaced = redirect?.type === 'replace' && redirect.path === path;
    update(projectId, (s) => syncPath(s, pathname, (p) => pathGroup(p, projectId), replaced));
  }, [path, pathname, projectId, router, update]);

  // Warm every background tab's route: a click is a client transition, never a
  // cold load. Keyed on the inactive tabs, so a navigation in the active tab
  // does not re-run it.
  // Same guard as `go`: a stored path is prefetched only when it is a page of
  // this project.
  const prefetchPaths = project.tabs
    .filter((tab) => tab.id !== project.activeId && tabRoute(tab.path, projectId))
    .map((tab) => tab.path);
  // A JSON array, not a joined string: no path can split into two.
  const pathsKey = JSON.stringify(prefetchPaths);
  useEffect(() => {
    for (const path of JSON.parse(pathsKey) as string[]) router.prefetch(path);
  }, [pathsKey, router]);

  // Read through a ref so every handler below stays referentially stable and
  // the memoised tabs do not re-render on each navigation.
  // Mounted: the strip owns the tab shortcuts and links open tabs
  // (`desktopTabsMounted`). Before paint, so no keystroke falls between.
  // The shell shows its tab menu items (New Tab, Mod+1…9) only while the
  // strip is mounted; an older shell has no `setTabsActive`.
  useLayoutEffect(() => {
    document.documentElement.setAttribute(MOUNTED_ATTRIBUTE, '');
    const shell = (window as { kortixDesktop?: { setTabsActive?: (active: boolean) => void } })
      .kortixDesktop;
    shell?.setTabsActive?.(true);
    return () => {
      document.documentElement.removeAttribute(MOUNTED_ATTRIBUTE);
      shell?.setTabsActive?.(false);
    };
  }, []);

  const pathnameRef = useRef(pathname);
  useLayoutEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  /** Show `path` for a tab switch that `fromId` was in front of. */
  const go = useCallback(
    (path: string | null, fromId: string | null = null) => {
      // Only a page of this project. Persisted tabs come back from local
      // storage, so a stored path is never trusted as a navigation target.
      if (!path || !tabRoute(path, projectId)) return;
      if (path !== pathnameRef.current) {
        // A newer push supersedes the pending one: the router drops it.
        handoff.current = null;
        router.push(path);
        return;
      }
      // No push (the window already shows `path`), so a pending link would
      // still land here — mark it as the overtaken tab's.
      const pending = inFlight.current;
      handoff.current = pending ? { stalePath: pending, fromId, toPath: path } : null;
    },
    [projectId, router],
  );

  const activate = useCallback(
    (id: string) => {
      const tab = readProjectTabs(projectId).tabs.find((x) => x.id === id);
      if (!tab) return;
      const from = readProjectTabs(projectId).activeId;
      update(projectId, (s) => (s.activeId === id ? s : { ...s, activeId: id }));
      go(tab.path, from);
    },
    [go, projectId, update],
  );

  // The sidebar's Customize row goes back to the settings tab you were last
  // in, as you left it. Its link names the landing section (Agents) only for
  // a window with no settings tab; following it otherwise would open Agents
  // again each time you return to settings.
  useEffect(() => {
    const onSettingsEntry = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const entry = (e.target as Element | null)?.closest?.(`a[${SETTINGS_ENTRY_ATTRIBUTE}]`);
      if (!entry) return;
      const { tabs, recent = [] } = readProjectTabs(projectId);
      const settings = tabs.filter((tab) => isSettingsGroup(pathGroup(tab.path, projectId)));
      const last =
        [...recent].reverse().flatMap((id) => settings.filter((tab) => tab.id === id))[0] ??
        settings.at(-1);
      if (!last) return;
      // Stops the link (Next's and the sidebar's handlers check this).
      e.preventDefault();
      activate(last.id);
    };
    document.addEventListener('click', onSettingsEntry, { capture: true });
    return () => document.removeEventListener('click', onSettingsEntry, { capture: true });
  }, [activate, projectId]);

  const close = useCallback(
    (id: string) => {
      const result = closeTab(readProjectTabs(projectId), id);
      update(projectId, () => result.state);
      if (result.state.tabs.length === 0) {
        // The last tab closed: the window keeps one tab, on the project home.
        update(projectId, (s) => openTab(s, newTabPath(projectId)));
        go(newTabPath(projectId));
        return;
      }
      go(result.navigateTo);
    },
    [go, projectId, update],
  );

  const openNew = useCallback(
    (afterId?: string, path = newTabPath(projectId)) => {
      const from = readProjectTabs(projectId).activeId;
      // A blank tab is only ever one: `+` again focuses it. Duplicate (an
      // explicit path) always opens a copy.
      update(projectId, (s) =>
        path === newTabPath(projectId)
          ? openBlankTab(s, path, (p) => pathGroup(p, projectId), afterId)
          : openTab(s, path, afterId),
      );
      // Same path (already home): the tab still opens; nothing to navigate.
      go(path, from);
    },
    [go, projectId, update],
  );

  const reopen = useCallback(() => {
    const next = reopenClosed(readProjectTabs(projectId));
    update(projectId, () => next);
    go(next.tabs.find((tab) => tab.id === next.activeId)?.path ?? null);
  }, [go, projectId, update]);

  const newToRight = useCallback((id: string) => openNew(id), [openNew]);
  const duplicate = useCallback((id: string, path: string) => openNew(id, path), [openNew]);
  const keep = useCallback(
    (id: string) => update(projectId, (s) => keepTab(s, id)),
    [projectId, update],
  );
  const pin = useCallback(
    (id: string, pinned: boolean) => update(projectId, (s) => setPinned(s, id, pinned)),
    [projectId, update],
  );
  const closeOthersOf = useCallback(
    (id: string) => {
      const next = closeOthers(readProjectTabs(projectId), id);
      update(projectId, () => next);
      go(next.tabs.find((x) => x.id === id)?.path ?? null);
    },
    [go, projectId, update],
  );
  const closeRightOf = useCallback(
    (id: string) => {
      const next = closeToRight(readProjectTabs(projectId), id);
      update(projectId, () => next);
      go(next.tabs.find((x) => x.id === next.activeId)?.path ?? null);
    },
    [go, projectId, update],
  );

  const cycle = useCallback(
    (delta: number) => {
      const { tabs, activeId } = readProjectTabs(projectId);
      if (tabs.length < 2) return;
      const idx = Math.max(
        0,
        tabs.findIndex((tab) => tab.id === activeId),
      );
      activate(tabs[(idx + delta + tabs.length) % tabs.length].id);
    },
    [activate, projectId],
  );

  // Tab actions arrive two ways: a keystroke the page sees, and a native menu
  // accelerator the shell sends as a command (File, Go menus). The menu path
  // is the one that works while an artifact or App frame holds focus, where no
  // keystroke reaches the page. One keystroke can arrive both ways, so `run`
  // performs it once. Keys: Cmd on macOS, Ctrl elsewhere.
  // Capture phase: inner editors (the composer) must not swallow Mod+T.
  useEffect(() => {
    const mac = isMac();
    let last = { action: '', at: 0, source: '' };
    const perform = (action: string): boolean => {
      const { tabs, activeId } = readProjectTabs(projectId);
      if (action === 'new-tab') openNew();
      else if (action === 'reopen-tab') reopen();
      else if (action === 'next-tab') cycle(1);
      else if (action === 'prev-tab') cycle(-1);
      else if (action === 'close-tab') {
        if (!activeId) return false;
        close(activeId);
      } else {
        const n = Number(action.match(/^select-tab-([1-9])$/)?.[1]);
        if (!n) return false;
        const target = n === 9 ? tabs.at(-1) : tabs[n - 1];
        if (!target) return false;
        if (target.id !== activeId) activate(target.id);
      }
      return true;
    };
    // The same action from the OTHER source within 500 ms is the same
    // keystroke; from the same source it is a second press (⌘T twice = two tabs).
    const run = (action: string, source: 'key' | 'menu'): boolean => {
      const now = Date.now();
      if (last.action === action && last.source !== source && now - last.at < 500) return true;
      last = { action, at: now, source };
      return perform(action);
    };
    const actionFor = (e: KeyboardEvent): string | null => {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle on every OS.
      if (e.code === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
        return e.shiftKey ? 'prev-tab' : 'next-tab';
      }
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod) return null;
      if (e.code === 'KeyT' && !e.altKey) return e.shiftKey ? 'reopen-tab' : 'new-tab';
      if (e.altKey && !e.shiftKey && (e.code === 'ArrowRight' || e.code === 'ArrowLeft')) {
        return e.code === 'ArrowRight' ? 'next-tab' : 'prev-tab';
      }
      if (e.shiftKey && !e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        return e.code === 'BracketRight' ? 'next-tab' : 'prev-tab';
      }
      if (e.altKey || e.shiftKey) return null;
      const digit = e.code.match(/^Digit([1-9])$/)?.[1];
      if (digit) return `select-tab-${digit}`;
      if (e.code === 'KeyW') return 'close-tab';
      return null;
    };
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e);
      if (!action) return;
      if (!run(action, 'key')) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onCommand = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (typeof action === 'string') run(action, 'menu');
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('kortix-desktop-command', onCommand);
    };
  }, [activate, close, cycle, openNew, projectId, reopen]);

  return { pathname, activate, close, openNew, reopen, newToRight, duplicate, keep, pin, closeOthersOf, closeRightOf };
}
