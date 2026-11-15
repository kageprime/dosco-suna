'use client';

import { type RefObject, useEffect } from 'react';

/**
 * Keeps bottom-right toasts clear of a composer docked at the bottom of the
 * window. The app's `<Toaster>` reads its bottom offset from
 * `--toast-offset-bottom` (`apps/web/src/app/[locale]/layout.tsx`); a docked
 * composer sets that variable to the distance from its top edge to the window
 * bottom while it shares the toast lane. Before this, a toast covered the
 * session composer's Send/Stop button (dev audit, 2026-11-14).
 */
export const TOAST_OFFSET_VAR = '--toast-offset-bottom';
/**
 * The toast's right offset while it is lifted. A lifted toast aligns its right
 * edge with the composer's right edge, so it sits flush above the composer
 * instead of straddling whatever is docked to the composer's right (the
 * session's side panel).
 */
export const TOAST_OFFSET_RIGHT_VAR = '--toast-offset-right';

/** Sonner's default edge offset on desktop. */
const EDGE_PX = 24;
/** Sonner's toast width. */
const TOAST_WIDTH_PX = 356;
/** The element whose resize moves a docked composer (the chat column). */
export const TOAST_ANCHOR_ATTR = 'data-toast-anchor';

/** Sonner stacks toasts full width at and below this viewport width. */
const MOBILE_BREAKPOINT_PX = 600;
/** Space between the composer's top edge and the lowest toast. */
const GAP_PX = 12;
/** A composer whose bottom edge is this close to the window bottom is docked there. */
const DOCKED_BOTTOM_PX = 160;

export interface ClearanceRect {
  top: number;
  right: number;
  width: number;
  height: number;
}

/**
 * The bottom offset that puts a toast just above `rect`, or 0 when the element
 * is hidden or not docked at the window bottom. A docked composer always
 * hosts the toast, wherever it sits horizontally: the toast stands above it,
 * right-aligned with it (`toastRightOffset`). Anchoring to the window corner
 * instead left the toast straddling whatever is docked beside the composer
 * (the session's side panel). A tall composer (long draft, attachments) still
 * counts: only its bottom edge says whether it is docked.
 */
export function toastClearance(rect: ClearanceRect & { bottom: number }, viewport: { width: number; height: number }): number {
  if (rect.width === 0 || rect.height === 0) return 0;
  if (viewport.height - rect.bottom > DOCKED_BOTTOM_PX) return 0;
  return Math.max(0, Math.ceil(viewport.height - rect.top + GAP_PX));
}

/**
 * The right offset that aligns a lifted toast with `rect`'s right edge, or 0
 * (keep the default) when nothing lifts it or the viewport stacks toasts full
 * width. Never closer to the window edge than Sonner's own 24px.
 */
export function toastRightOffset(rect: { right: number }, viewport: { width: number }, bottom: number): number {
  if (bottom <= 0 || viewport.width <= MOBILE_BREAKPOINT_PX) return 0;
  // Never past the left window edge either: a narrow window with a wide side
  // panel leaves less than a toast's width left of the composer's right edge.
  const max = viewport.width - TOAST_WIDTH_PX - EDGE_PX;
  return Math.max(EDGE_PX, Math.min(max, Math.ceil(viewport.width - rect.right)));
}

// replica-local: one entry per mounted docked composer in this window.
const clearances = new Map<symbol, { bottom: number; right: number }>();

function apply(): void {
  if (typeof document === 'undefined') return;
  // The composer that lifts the toast highest decides both offsets.
  let top = { bottom: 0, right: 0 };
  for (const c of clearances.values()) if (c.bottom > top.bottom) top = c;
  const root = document.documentElement.style;
  if (top.bottom > 0) root.setProperty(TOAST_OFFSET_VAR, `${top.bottom}px`);
  else root.removeProperty(TOAST_OFFSET_VAR);
  if (top.right > 0) root.setProperty(TOAST_OFFSET_RIGHT_VAR, `${top.right}px`);
  else root.removeProperty(TOAST_OFFSET_RIGHT_VAR);
}

/** Registers `ref`'s element as a docked composer while `active`. */
export function useToastClearance(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof window === 'undefined') return;
    const id = Symbol('toast-clearance');
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const bottom = toastClearance(rect, viewport);
      const right = toastRightOffset(rect, viewport, bottom);
      const prev = clearances.get(id);
      if (prev && prev.bottom === bottom && prev.right === right) return;
      clearances.set(id, { bottom, right });
      apply();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    // The composer is width-capped and centered, so a side panel opening
    // MOVES it without resizing it. The column it sits in (marked with
    // `data-toast-anchor`) does resize, so watch that too, or the right offset
    // keeps the pre-panel position.
    const anchor = el.closest(`[${TOAST_ANCHOR_ATTR}]`);
    if (anchor) observer?.observe(anchor);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      clearances.delete(id);
      apply();
    };
  }, [ref, active]);
}
