'use client';

import { useEffect, type RefObject } from 'react';

import { useWorkspaceSettingsRailStore } from '../../internal/stores/workspace-settings-rail-store';

/** How long the page may take to render the card before the landing gives up. */
const FIND_TIMEOUT_MS = 4000;

/** A row taller than this is a whole card: the mark stays on the row. */
const ROW_MAX_HEIGHT_PX = 160;

/**
 * Lands a settings search result: when the result's section is on screen,
 * scroll to the card or row whose text the result names, then mark it once.
 *
 * The panes are lazy and some load their data first, so the text can appear
 * well after the route commits. A MutationObserver waits for it, up to 4s.
 * No match (another locale, a card this caller cannot see) leaves the page
 * at its top: the section itself still opened.
 */
export function useSettingsSearchLanding(
  projectId: string,
  section: string | undefined,
  rootRef: RefObject<HTMLElement | null>,
) {
  const pending = useWorkspaceSettingsRailStore((s) => s.pendingFind);
  const setPendingFind = useWorkspaceSettingsRailStore((s) => s.setPendingFind);

  useEffect(() => {
    const root = rootRef.current;
    if (!pending || !root || pending.projectId !== projectId || pending.section !== section) return;
    const text = pending.text.trim().toLowerCase();

    const land = (): boolean => {
      const target = findText(root, text);
      if (!target) return false;
      const row = rowOf(target, root);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Instant: a long smooth scroll is motion the person did not ask for.
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      mark(row, reduce);
      return true;
    };

    if (land()) {
      setPendingFind(null);
      return;
    }
    const observer = new MutationObserver(() => {
      if (land()) finish();
    });
    const timer = window.setTimeout(() => finish(), FIND_TIMEOUT_MS);
    function finish() {
      observer.disconnect();
      window.clearTimeout(timer);
      setPendingFind(null);
    }
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [pending, projectId, section, rootRef, setPendingFind]);
}

/** The first visible element whose own text is exactly `text` (case-insensitive). */
function findText(root: HTMLElement, text: string): HTMLElement | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.trim().toLowerCase() !== text) continue;
    const element = node.parentElement;
    // Skip text inside a closed disclosure, a hidden tab or an input's options.
    if (element && element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"], option')) {
      return element;
    }
  }
  return null;
}

/**
 * The row the text heads: climb while the parent is still row-sized, so the
 * mark covers the label, its description and its control. Stop below a
 * bordered box: that box is the card, and the row is one of its rows.
 */
function rowOf(element: HTMLElement, root: HTMLElement): HTMLElement {
  let row = element;
  for (let parent = row.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.getBoundingClientRect().height > ROW_MAX_HEIGHT_PX) break;
    row = parent;
    if (hasBorder(row)) break;
  }
  return row;
}

function hasBorder(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderBottomWidth) > 0;
}

/**
 * Marks the row once: a quiet tint that holds for 700ms, then fades over
 * 300ms (the motion ceiling). An inset shadow paints over the row's own
 * background, so a row on a card keeps its card colour underneath. Under
 * reduced motion the tint holds and then simply leaves, with no fade.
 */
function mark(row: HTMLElement, reduce: boolean) {
  const tint = 'inset 0 0 0 100vmax color-mix(in oklab, var(--foreground) 6%, transparent)';
  const clear = 'inset 0 0 0 100vmax transparent';
  row.animate(
    reduce
      ? [{ boxShadow: tint }, { boxShadow: tint, offset: 0.999 }, { boxShadow: clear }]
      : [{ boxShadow: tint }, { boxShadow: tint, offset: 0.7 }, { boxShadow: clear }],
    { duration: 1000, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
}
