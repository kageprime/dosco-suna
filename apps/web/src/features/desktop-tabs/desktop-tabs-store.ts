'use client';

import { createSafeJSONStorage } from '@kortix/ui/internal/lib/storage/managed-storage';
import {
  registerPersistedStore,
  resetPersistedStore,
} from '@kortix/ui/internal/stores/persisted-store-registry';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { HOME_GROUP, isDocumentGroup, isSessionGroup, tabRoute } from './tab-route';

/**
 * The desktop window's tab strip, per project.
 *
 * A tab is a browser tab: it holds one location (`path`, an app pathname with
 * its query) and follows navigation inside it. Navigating in the sidebar moves
 * the ACTIVE tab; `+`, Mod+T and "New tab to the right" add one. Pinned tabs
 * sit first and render as an icon only.
 *
 * Pure state and pure transitions. Navigation (router.push) belongs to the
 * strip component, so every transition here is testable without a router.
 */

export interface DesktopTab {
  id: string;
  /** App pathname plus query, e.g. `/workspaces/<id>/sessions/<sid>`. */
  path: string;
  pinned?: boolean;
  /**
   * The tab you are browsing in: a session, an artifact or a settings section
   * opened by a plain click. The next plain click on another one replaces it
   * instead of adding a tab. It becomes a normal tab once you work in it (type
   * or press a control in the page), double-click it, pin it, drag it, or
   * switch to another tab: a tab you leave stays. Only the active tab can be
   * a preview (`settle`).
   */
  preview?: boolean;
  /** Closed tabs only: where it stood, so reopening puts it back there. */
  index?: number;
}

export interface ProjectTabs {
  tabs: DesktopTab[];
  activeId: string | null;
  /** Closed tabs, most recent last, for Mod+Shift+T. */
  closed: DesktopTab[];
  /** Tab ids in the order they were last in front, most recent last (`settle`). */
  recent?: string[];
}

export const MAX_TABS = 24;
const MAX_CLOSED = 16;
const MAX_TRACKED_PROJECTS = 24;
const STORAGE_KEY = 'kortix.desktop-tabs';

const EMPTY: ProjectTabs = { tabs: [], activeId: null, closed: [] };

let seq = 0;
export function newTabId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq.toString(36)}`;
}

/** Pinned tabs first, in their order; then the rest. Stable otherwise. */
function pinnedFirst(tabs: DesktopTab[]): DesktopTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  if (pinned.length === 0 || pinned.length === tabs.length) return tabs;
  return [...pinned, ...tabs.filter((t) => !t.pinned)];
}

/** `tabs` under the cap, focused on `activeId`; a tab the cap pushed out stays reopenable. */
function withCap(tabs: DesktopTab[], activeId: string, closed: DesktopTab[]): ProjectTabs {
  const kept = capTabs(tabs, activeId);
  const evicted = tabs
    .map((t, index) => ({ ...t, index }))
    .filter((t) => !kept.some((k) => k.id === t.id));
  return {
    tabs: kept,
    activeId,
    closed: evicted.length ? [...closed, ...evicted].slice(-MAX_CLOSED) : closed,
  };
}

/** Drop the oldest unpinned, inactive tab until the cap holds. */
function capTabs(tabs: DesktopTab[], activeId: string | null): DesktopTab[] {
  let next = tabs;
  while (next.length > MAX_TABS) {
    const victim = next.find((t) => !t.pinned && t.id !== activeId);
    if (!victim) break;
    next = next.filter((t) => t.id !== victim.id);
  }
  return next;
}

/* ─── Pure transitions ──────────────────────────────────────────────────── */

/**
 * The window moved to `path`. Where it lands, in order:
 *  1. The active tab is already there: nothing changes.
 *  2. A redirect (`replaced`: the page rewrote its own address, as Workspace
 *     settings does for a section the caller cannot open): the active tab's
 *     page is gone, so that tab moves, or closes when another tab already
 *     shows the destination.
 *  4. The active tab is the same destination (Goals → one goal, Agents → one
 *     agent): it navigates.
 *  5. Another tab shows the destination: that tab takes focus. A session or a
 *     settings section that has a tab is never opened twice, and never
 *     rewrites the tab you came from.
 *  6. The active tab is a blank New session tab: it navigates. A session it
 *     becomes is the person's own, never a preview.
 *  7. A document (a session, an artifact, a settings section): the tab you are
 *     browsing in (an active preview) shows it; else it opens in a new preview
 *     tab. Clicking through ten rows leaves one tab.
 *  8. Anything else opens in a new tab beside the active one.
 * A path outside the project (`groupOf` returns null) changes nothing.
 */
export function syncPath(
  state: ProjectTabs,
  path: string,
  groupOf: (path: string) => string | null,
  /** The navigation replaced the history entry: a redirect, not a click. */
  replaced = false,
): ProjectTabs {
  const group = groupOf(path);
  if (group === null) return state;
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active?.path === path) return state;
  const activeGroup = active ? groupOf(active.path) : null;
  const moveActive = (preview?: boolean): ProjectTabs => ({
    ...state,
    tabs: state.tabs.map((t) =>
      t.id === active?.id ? { id: t.id, path, pinned: t.pinned, preview } : t,
    ),
  });
  const owner = state.tabs.find((t) => t.id !== active?.id && groupOf(t.path) === group);
  const focusOwner = (tabs: DesktopTab[], to: DesktopTab): ProjectTabs => ({
    ...state,
    activeId: to.id,
    tabs: to.path === path ? tabs : tabs.map((t) => (t.id === to.id ? { ...t, path } : t)),
  });
  if (active && replaced) {
    if (!owner || activeGroup === group) return moveActive(active.preview);
    return focusOwner(
      state.tabs.filter((t) => t.id !== active.id),
      owner,
    );
  }
  if (active && activeGroup === group) return moveActive(active.preview);
  if (owner) return focusOwner(state.tabs, owner);
  const browsing = isDocumentGroup(group) && !isSessionGroup(group);
  if (active && activeGroup === HOME_GROUP) return moveActive(browsing || undefined);
  // The window's first tab is the one you work in, never a preview.
  if (isDocumentGroup(group) && state.tabs.length > 0) {
    if (active?.preview && !active.pinned) return moveActive(true);
    return openTab(state, path, null, false, true);
  }
  return openTab(state, path);
}

/**
 * What every change to the tabs goes through (the store's `update`):
 *  - a preview tab you switch away from becomes a normal tab, so only the
 *    active tab is ever a preview;
 *  - `recent` records the order tabs were last in front, for `closeTab`.
 */
export function settle(prev: ProjectTabs, next: ProjectTabs): ProjectTabs {
  if (next === prev) return next;
  const tabs = next.tabs.some((t) => t.preview && t.id !== next.activeId)
    ? next.tabs.map((t) =>
        t.preview && t.id !== next.activeId ? { id: t.id, path: t.path, pinned: t.pinned } : t,
      )
    : next.tabs;
  const open = new Set(tabs.map((t) => t.id));
  const before = next.recent ?? prev.recent ?? [];
  const kept = before.filter((id) => open.has(id) && id !== next.activeId);
  const recent = next.activeId && open.has(next.activeId) ? [...kept, next.activeId] : kept;
  const sameRecent =
    recent.length === before.length && recent.every((id, i) => id === before[i]);
  if (tabs === next.tabs && sameRecent && next.recent) return next;
  return { ...next, tabs, recent: sameRecent ? before : recent };
}

/**
 * `+` / Mod+T: a blank New session tab. There is only ever one: when it is
 * already open, it takes focus instead of a second blank tab appearing.
 */
export function openBlankTab(
  state: ProjectTabs,
  path: string,
  groupOf: (path: string) => string | null,
  afterId?: string | null,
): ProjectTabs {
  const blank = state.tabs.find((t) => groupOf(t.path) === HOME_GROUP);
  if (blank) return blank.id === state.activeId ? state : { ...state, activeId: blank.id };
  return openTab(state, path, afterId);
}

/** The preview tab becomes a normal tab. Same state back when `id` is not a preview. */
export function keepTab(state: ProjectTabs, id: string | null): ProjectTabs {
  const tab = id ? state.tabs.find((t) => t.id === id) : undefined;
  if (!tab?.preview) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { id: t.id, path: t.path, pinned: t.pinned } : t)) };
}

/**
 * Open `path` in a new tab after `afterId` (default: the active tab), and focus
 * it — or, with `background`, leave focus where it is (⌘-click, middle-click).
 */
export function openTab(
  state: ProjectTabs,
  path: string,
  afterId?: string | null,
  background = false,
  preview = false,
): ProjectTabs {
  const tab: DesktopTab = preview ? { id: newTabId(), path, preview } : { id: newTabId(), path };
  const anchor = afterId ?? state.activeId;
  const idx = state.tabs.findIndex((t) => t.id === anchor);
  // A new tab never lands inside the pinned group.
  const firstUnpinned = state.tabs.findIndex((t) => !t.pinned);
  const minIdx = firstUnpinned === -1 ? state.tabs.length : firstUnpinned;
  const at = idx === -1 ? state.tabs.length : Math.max(idx + 1, minIdx);
  const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
  const opened = withCap(tabs, tab.id, state.closed);
  return background && state.activeId && opened.tabs.some((t) => t.id === state.activeId)
    ? { ...opened, activeId: state.activeId }
    : opened;
}

/**
 * Close one tab. Closing the active tab goes back to the tab that was in front
 * before it (`recent`): close Settings and you are in the session you opened
 * it from. With no history, the right neighbour, or the left one when it was
 * last. Returns the next state and the path the window must show, or null when
 * the active tab did not change.
 */
export function closeTab(
  state: ProjectTabs,
  id: string,
): { state: ProjectTabs; navigateTo: string | null } {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return { state, navigateTo: null };
  const { preview: _preview, ...closing } = state.tabs[idx];
  const closedTab = { ...closing, index: idx };
  const tabs = state.tabs.filter((t) => t.id !== id);
  const closed = [...state.closed.filter((t) => t.path !== closedTab.path), closedTab].slice(
    -MAX_CLOSED,
  );
  if (state.activeId !== id) {
    return { state: { ...state, tabs, closed }, navigateTo: null };
  }
  const previous = [...(state.recent ?? [])]
    .reverse()
    .map((recentId) => tabs.find((t) => t.id === recentId))
    .find((t) => t !== undefined);
  const next = previous ?? tabs[idx] ?? tabs[idx - 1] ?? null;
  return {
    state: { ...state, tabs, closed, activeId: next?.id ?? null },
    navigateTo: next?.path ?? null,
  };
}

/** Keep only `id` (and every pinned tab). */
export function closeOthers(state: ProjectTabs, id: string): ProjectTabs {
  const keep = state.tabs.filter((t) => t.id === id || t.pinned);
  const gone = state.tabs
    .map((t, index) => ({ ...t, index }))
    .filter((t) => !keep.some((k) => k.id === t.id));
  return {
    tabs: keep,
    activeId: id,
    closed: [...state.closed, ...gone].slice(-MAX_CLOSED),
  };
}

/** Close every unpinned tab to the right of `id`. */
export function closeToRight(state: ProjectTabs, id: string): ProjectTabs {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  const gone = state.tabs
    .map((t, index) => ({ ...t, index }))
    .slice(idx + 1)
    .filter((t) => !t.pinned);
  if (gone.length === 0) return state;
  const tabs = state.tabs.filter((t) => !gone.some((g) => g.id === t.id));
  const activeId = tabs.some((t) => t.id === state.activeId) ? state.activeId : id;
  return { tabs, activeId, closed: [...state.closed, ...gone].slice(-MAX_CLOSED) };
}

export function reopenClosed(state: ProjectTabs): ProjectTabs {
  const last = state.closed.at(-1);
  if (!last) return state;
  const closed = state.closed.slice(0, -1);
  // Back where it stood (clamped to the current list), pinned state included.
  const { index = state.tabs.length, preview: _preview, ...tab } = last;
  const at = Math.min(index, state.tabs.length);
  const tabs = pinnedFirst([...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)]);
  return withCap(tabs, tab.id, closed);
}

export function setPinned(state: ProjectTabs, id: string, pinned: boolean): ProjectTabs {
  // A pinned tab is kept for good: it is never a preview.
  const tabs = state.tabs.map((t) =>
    t.id === id ? { id: t.id, path: t.path, ...(pinned ? { pinned: true } : {}) } : t,
  );
  // Pinning moves the tab to the end of the pinned group; unpinning moves it to
  // the start of the unpinned group. Both are what the strip shows anyway.
  const target = tabs.find((t) => t.id === id);
  if (!target) return state;
  const rest = tabs.filter((t) => t.id !== id);
  const pinnedCount = rest.filter((t) => t.pinned).length;
  const ordered = [...rest.slice(0, pinnedCount), target, ...rest.slice(pinnedCount)];
  return { ...state, tabs: ordered };
}

/** Reorder by the ids the strip reports after a drag. Pinned stay first. */
export function reorder(state: ProjectTabs, ids: string[]): ProjectTabs {
  const byId = new Map(state.tabs.map((t) => [t.id, t]));
  const tabs = ids.map((id) => byId.get(id)).filter((t): t is DesktopTab => !!t);
  if (tabs.length !== state.tabs.length) return state;
  return { ...state, tabs: pinnedFirst(tabs) };
}

/* ─── Persisted shape ───────────────────────────────────────────────────── */

function cleanTab(value: unknown): DesktopTab | null {
  if (!value || typeof value !== 'object') return null;
  const { id, path, pinned, preview, index } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof path !== 'string') return null;
  const tab: DesktopTab = { id, path };
  if (pinned === true) tab.pinned = true;
  else if (preview === true) tab.preview = true;
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) tab.index = index;
  return tab;
}

function cleanTabs(value: unknown): DesktopTab[] {
  return Array.isArray(value) ? value.map(cleanTab).filter((t): t is DesktopTab => t !== null) : [];
}

/**
 * The stored value, as read back from local storage, reduced to the shape the
 * strip renders. Old versions, a full bucket written halfway, or a hand-edited
 * profile can hold anything; a tab whose `path` is not a string used to throw
 * in render and take the project shell down with it.
 */
export function sanitizePersisted(value: unknown): { byProject: Record<string, ProjectTabs> } {
  const byProject: Record<string, ProjectTabs> = {};
  const raw =
    value && typeof value === 'object' ? (value as { byProject?: unknown }).byProject : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { byProject };
  for (const [projectId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { tabs: rawTabs, activeId, closed } = entry as Record<string, unknown>;
    // Only the active tab can be a preview (checked below, once it is known).
    let seenPreview = false;
    // Only pages of this project: a stored `javascript:` URL or another
    // project's path would otherwise be an empty "Page" tab.
    const routable = (tab: DesktopTab) => tabRoute(tab.path, projectId) !== null;
    const tabs = cleanTabs(rawTabs).filter(routable).map((tab) => {
      if (!tab.preview) return tab;
      if (!seenPreview) return (seenPreview = true), tab;
      return { id: tab.id, path: tab.path };
    });
    const active =
      typeof activeId === 'string' && tabs.some((t) => t.id === activeId) ? activeId : null;
    const { recent } = entry as Record<string, unknown>;
    byProject[projectId] = {
      tabs: tabs.map((tab) =>
        tab.preview && tab.id !== active ? { id: tab.id, path: tab.path } : tab,
      ),
      activeId: active,
      closed: cleanTabs(closed).filter(routable),
      recent: Array.isArray(recent)
        ? recent.filter((id): id is string => typeof id === 'string' && tabs.some((t) => t.id === id))
        : [],
    };
  }
  return { byProject };
}

/* ─── Store ─────────────────────────────────────────────────────────────── */

interface Store {
  byProject: Record<string, ProjectTabs>;
  update: (projectId: string, fn: (state: ProjectTabs) => ProjectTabs) => void;
}

export function readProjectTabs(projectId: string): ProjectTabs {
  return useDesktopTabsStore.getState().byProject[projectId] ?? EMPTY;
}

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_PROJECTS) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_PROJECTS).map((k) => [k, map[k]]));
}

export const useDesktopTabsStore = create<Store>()(
  persist(
    (set, get) => ({
      byProject: {},
      update: (projectId, fn) => {
        const current = get().byProject[projectId] ?? EMPTY;
        const next = settle(current, fn(current));
        if (next === current) return;
        // Re-insert the key last: map order is the recency order pruning keeps.
        const { [projectId]: _drop, ...rest } = get().byProject;
        set({ byProject: { ...rest, [projectId]: next } });
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({ byProject: pruneProjects(state.byProject) }),
      // Never trust what comes back from storage: keep only well-formed tabs.
      merge: (persisted, current) => ({ ...current, ...sanitizePersisted(persisted) }),
    },
  ),
);

export const EMPTY_PROJECT_TABS = EMPTY;

/** Keep the active tab when it is the preview. Free otherwise: no write, no render. */
export function keepActivePreview(projectId: string): void {
  const state = readProjectTabs(projectId);
  if (!state.tabs.some((t) => t.id === state.activeId && t.preview)) return;
  useDesktopTabsStore.getState().update(projectId, (s) => keepTab(s, s.activeId));
}

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useDesktopTabsStore));
