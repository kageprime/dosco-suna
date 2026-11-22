'use client';

/**
 * The action panel column — the Outputs/Context/Preview sections as a docked
 * pane beside the chat.
 *
 * IN FLOW, never an overlay. It sits beside the chat as a sibling, so opening
 * it takes width away from the transcript and the chat re-centers itself in
 * what is left.
 *
 * Docked, not floating. One hairline (`border-l`) separates it from the chat
 * and it runs the full height of the body, under the session header's rule.
 * The sections inside are flat rows divided by hairlines (`easy/panel-card.tsx`).
 * No card, radius or shadow: the brand rule for an in-flow surface
 * (`effects.md`), and the look of a docked pane.
 *
 * Resizable. The left edge is a drag handle (pointer and arrow keys); the width
 * persists per browser. Double-click the edge to reset it.
 *
 * Its toggle lives in the session header (`session-site-header.tsx`), beside
 * the other panel controls, never as a rail over the chat.
 *
 * It toggles ONLY itself. Opening it never opens the right-hand detail panel;
 * that surface is content-driven and opens when something gives it a detail to
 * show. See the store's `isActionPanelOpen` doc comment.
 *
 * The reverse is a RENDER rule, not a state one: while a detail panel is up
 * (browser, terminal, files, file preview) this whole column hides, so the
 * session is the chat plus the one thing being looked at. No state is written
 * for that — closing the detail brings the column back as it was.
 *
 * ⌘I / Ctrl+I lives here, but it does NOT mean "toggle this column". It means
 * "toggle the right side", which is `toggleRightPanel` in the store: close
 * whatever is docked there — this column, a detail panel, or both — and, when
 * nothing is, reopen what this session was last showing, falling back to this
 * column. One key for one visual region.
 *
 * The binding lives on this component only because this is the surface that is
 * always mounted for a session (the detail panel is content-driven and may
 * have nothing to render). It stays mounted while `hidden` under a detail,
 * which is what lets the key close that detail.
 */

import { ActionPanel } from './action-panel';
import { useOptionalSessionPanel } from './session-panel-provider';
import { useIsMobile } from '../../internal/hooks';
import { cn } from '../../lib/utils';
import { useTranslations } from '../../i18n';
import { RESIZE_SEAM_CLASS } from '../../primitives/resize-seam';
import {
  useIsActionPanelOpen,
  useIsSidePanelOpen,
  useToggleRightPanel,
} from '../../internal/stores/kortix-computer-store';
import { useTabStore } from '../../internal/stores/tab-store';
import { m } from 'motion/react';
import { useReducedMotion } from '../../internal/hooks/use-reduced-motion';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** Width bounds, in px. The chat keeps at least the rest of the row. */
export const ACTION_PANEL_DEFAULT_WIDTH = 340;
export const ACTION_PANEL_MIN_WIDTH = 280;
export const ACTION_PANEL_MAX_WIDTH = 560;
/** One arrow-key step on the resize edge. */
const KEY_STEP = 16;
const WIDTH_STORAGE_KEY = 'kortix:session-action-panel-width';

export function clampActionPanelWidth(width: number, max = ACTION_PANEL_MAX_WIDTH): number {
  if (!Number.isFinite(width)) return ACTION_PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(ACTION_PANEL_MIN_WIDTH, width)));
}

/**
 * The width on screen and the widest it may go right now, read from the DOM.
 * The column is capped at half its row (`max-w-[50cqw]`), so on a narrow
 * window the visible width is below the stored one. A resize must start from
 * what the user sees, or the edge does not follow the pointer until the drag
 * passes the stored width.
 */
function liveBounds(handle: HTMLElement) {
  const column = handle.parentElement;
  const row = column?.parentElement;
  const rendered = column?.getBoundingClientRect().width ?? ACTION_PANEL_DEFAULT_WIDTH;
  const max = row
    ? Math.min(ACTION_PANEL_MAX_WIDTH, Math.floor(row.getBoundingClientRect().width / 2))
    : ACTION_PANEL_MAX_WIDTH;
  return { rendered, max };
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    return raw ? clampActionPanelWidth(Number(raw)) : ACTION_PANEL_DEFAULT_WIDTH;
  } catch {
    return ACTION_PANEL_DEFAULT_WIDTH;
  }
}

/** Same-tab writers notify through this event; other tabs through `storage`. */
const WIDTH_EVENT = 'kortix:session-action-panel-width';
/** Set only while storage writes fail, so a resize still lasts for this page.
 *  A working store stays the source of truth, which keeps other tabs' writes
 *  (the `storage` event) visible here. */
let memoryWidth: number | null = null;

function writeStoredWidth(width: number) {
  try {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    memoryWidth = null;
  } catch {
    memoryWidth = width;
  }
  window.dispatchEvent(new Event(WIDTH_EVENT));
}

function subscribeStoredWidth(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WIDTH_STORAGE_KEY) onChange();
  };
  window.addEventListener(WIDTH_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(WIDTH_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

const getStoredWidth = () => memoryWidth ?? readStoredWidth();
// The server has no storage: it renders the default, and the client swaps in
// the stored width after hydration without a mismatch.
const getServerWidth = () => ACTION_PANEL_DEFAULT_WIDTH;

/**
 * The column's width, plus a drag/keyboard handle for its left edge. The edge
 * sits on the column's LEFT, so dragging left (a smaller clientX) widens it.
 */
function useActionPanelWidth() {
  const storedWidth = useSyncExternalStore(subscribeStoredWidth, getStoredWidth, getServerWidth);
  // The live width while a drag is in flight; storage is written once, on drop.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{
    startX: number;
    startWidth: number;
    max: number;
    /** The latest width the pointer asked for; what a drop saves. */
    last: number;
    /** False for a plain click: a click on the edge must not save anything. */
    moved: boolean;
  } | null>(null);
  const width = dragWidth ?? storedWidth;
  const dragging = dragWidth !== null;

  const commit = useCallback((next: number, max?: number) => {
    writeStoredWidth(clampActionPanelWidth(next, max));
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const { rendered, max } = liveBounds(e.currentTarget);
      const start = clampActionPanelWidth(rendered, max);
      drag.current = { startX: e.clientX, startWidth: start, max, last: start, moved: false };
      setDragWidth(start);
    },
    [],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const next = clampActionPanelWidth(start.startWidth + (start.startX - e.clientX), start.max);
    start.last = next;
    if (e.clientX !== start.startX) start.moved = true;
    setDragWidth(next);
  }, []);

  const onPointerEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const ended = drag.current;
      if (!ended) return;
      drag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Saved from the ref, not from render state: the last move may not have
      // rendered yet when the pointer lifts.
      if (ended.moved) commit(ended.last);
      setDragWidth(null);
    },
    [commit],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
      const { rendered, max } = liveBounds(e.currentTarget);
      if (e.key === 'ArrowLeft') commit(rendered + step, max);
      else if (e.key === 'ArrowRight') commit(rendered - step, max);
      else if (e.key === 'Home') commit(max, max);
      else if (e.key === 'End') commit(ACTION_PANEL_MIN_WIDTH, max);
      else return;
      e.preventDefault();
    },
    [commit],
  );

  const onDoubleClick = useCallback(() => commit(ACTION_PANEL_DEFAULT_WIDTH), [commit]);

  return {
    width,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onKeyDown,
      onDoubleClick,
    },
  };
}

/**
 * Motion. Pushing the chat aside IS a layout change, so the width animates —
 * one 200ms one-shot on an explicit toggle, on a single element. Ease-out,
 * 200ms in, 160ms out. A drag never animates: the edge follows the pointer.
 */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const ENTER = { duration: 0.2, ease: EASE_OUT } as const;
const EXIT = { duration: 0.16, ease: EASE_OUT } as const;
const INSTANT = { duration: 0 } as const;

export function SessionActionPanelColumn({
  /**
   * Own the ⌘I / Ctrl+I binding. False for the instant boot shell: it and the
   * real chat are BOTH mounted for the length of the crossfade, and two
   * listeners on one key call `toggleRight()` twice — the panel opens and shuts
   * in the same tick, so the shortcut reads as dead for that whole window. The
   * shell yields it; the surface that outlives the fade keeps it.
   */
  hotkey = true,
}: {
  hotkey?: boolean;
} = {}) {
  const t = useTranslations('sessionUi.panel');
  const panel = useOptionalSessionPanel();
  const isMobile = useIsMobile();
  const isOpen = useIsActionPanelOpen();
  // ⌘I's action — the whole right side, whichever surface is docked there.
  const toggleRight = useToggleRightPanel();
  const reduce = useReducedMotion();
  const { width, dragging, handleProps } = useActionPanelWidth();
  // Built once: a drag re-renders this column on every pointer move, and the
  // sections (Outputs can hold hundreds of rows) must not re-render with it.
  const sections = useMemo(() => <ActionPanel />, []);
  // The right-hand detail panel is showing a browser, a terminal, a file
  // explorer or a file preview.
  const detailPanelOpen = useIsSidePanelOpen();

  const sessionId = panel?.sessionId;
  const isInTabSystem = useTabStore((s) => (sessionId ? !!s.tabs[sessionId] : false));
  const isActiveTab = useTabStore((s) => (sessionId ? s.activeTabId === sessionId : false));
  // Inactive session tabs stay mounted. Only the visible tab may own ⌘I, or
  // every background layout would flip the shared `isActionPanelOpen` flag.
  const shouldHandleHotkey = hotkey && !!panel && !isMobile && (isInTabSystem ? isActiveTab : true);

  useEffect(() => {
    if (!shouldHandleHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        // NOT the column's own toggle — see this file's header. The key owns
        // the right side, so it also closes a detail panel.
        toggleRight();
      }
    };
    // The desktop shell sends the same key from inside a cross-origin iframe
    // (the Browser preview), where this window never sees it (KRTX-2944).
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'toggle-right-panel') toggleRight();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('kortix-desktop-command', onCommand);
    };
  }, [shouldHandleHotkey, toggleRight]);

  // No provider means no panel to render: `SessionChat` also renders read-only
  // inside `legacy-subagent-chat.tsx`, outside `SessionLayout`. Mobile has no
  // column either — at 375px a side column is the whole screen, so the
  // sections stay in the bottom drawer.
  if (!panel || isMobile) return null;

  return (
    // The width animates; the content inside is pinned to the open width, so
    // the sections slide into view instead of reflowing on every frame.
    <m.div
      initial={false}
      animate={{ width: isOpen ? width : 0 }}
      transition={reduce || dragging ? INSTANT : isOpen ? ENTER : EXIT}
      aria-hidden={!isOpen}
      inert={!isOpen || undefined}
      className={cn(
        // Never more than half the body row (`SessionBodyRow` is the
        // container): on a narrow window the chat keeps the other half.
        'relative z-10 min-h-0 max-w-[50cqw] shrink-0 self-stretch',
        // A detail panel is showing on the right: the column steps aside, so
        // the session is the chat plus the one thing being looked at. `hidden`,
        // not an unmount, so the sections keep their expanded state.
        detailPanelOpen && 'hidden',
      )}
      data-testid="session-action-panel"
    >
      {isOpen && (
        // The resize edge: zero-width over the column's `border-l`, with a
        // 12px hit strip. Hover, focus and drag light the shared resize seam.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resizePane')}
          // Approximate under the half-row cap: these report the stored
          // width and the fixed bounds, while the screen may show less.
          aria-valuemin={ACTION_PANEL_MIN_WIDTH}
          aria-valuemax={ACTION_PANEL_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          data-dragging={dragging || undefined}
          className={cn(
            'absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize touch-none outline-none',
            RESIZE_SEAM_CLASS,
            'hover:before:opacity-100 focus-visible:before:opacity-100 data-[dragging]:before:opacity-100',
          )}
          {...handleProps}
        />
      )}
      <div className="h-full overflow-hidden">
        <div
          className={cn(
            // The same cap as the column, so a capped column still shows its
            // sections whole instead of clipping their right edge.
            'border-border bg-background scrollbar-minimal h-full max-w-[50cqw] overflow-y-auto overscroll-contain border-l',
            // A drag must not select transcript text under the pointer.
            dragging && 'select-none',
          )}
          style={{ width }}
          data-review-scroll
        >
          {sections}
        </div>
      </div>
    </m.div>
  );
}
