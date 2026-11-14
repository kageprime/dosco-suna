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

/** Sonner's toast width (356px) plus its 24px edge offset. */
const TOAST_LANE_PX = 380;
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
 * The bottom offset a toast needs to clear `rect`, or 0 when the element is
 * hidden, outside the toast lane, or not docked at the window bottom. A tall
 * composer (long draft, attachments) still counts: only its bottom edge says
 * whether it is docked.
 */
export function toastClearance(rect: ClearanceRect & { bottom: number }, viewport: { width: number; height: number }): number {
  if (rect.width === 0 || rect.height === 0) return 0;
  const inLane = viewport.width <= MOBILE_BREAKPOINT_PX || rect.right > viewport.width - TOAST_LANE_PX;
  if (!inLane) return 0;
  if (viewport.height - rect.bottom > DOCKED_BOTTOM_PX) return 0;
  return Math.max(0, Math.ceil(viewport.height - rect.top + GAP_PX));
}

// replica-local: one entry per mounted docked composer in this window.
const clearances = new Map<symbol, number>();

function apply(): void {
  if (typeof document === 'undefined') return;
  const max = Math.max(0, ...clearances.values());
  const root = document.documentElement.style;
  if (max > 0) root.setProperty(TOAST_OFFSET_VAR, `${max}px`);
  else root.removeProperty(TOAST_OFFSET_VAR);
}

/** Registers `ref`'s element as a docked composer while `active`. */
export function useToastClearance(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof window === 'undefined') return;
    const id = Symbol('toast-clearance');
    const measure = () => {
      const next = toastClearance(el.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      if (clearances.get(id) === next) return;
      clearances.set(id, next);
      apply();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      clearances.delete(id);
      apply();
    };
  }, [ref, active]);
}
