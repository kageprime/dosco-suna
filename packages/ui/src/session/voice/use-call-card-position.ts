'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { safeGetItem, safeSetItem } from '../../internal/lib/storage/managed-storage';

/** A card spot as viewport pixels: the box's `left`/`top`, `right`/`bottom` off. */
export interface CallCardSpot {
  left: number;
  top: number;
}

const SPOT_KEY = 'kortix-voice-call-card';

/** Keep a spot fully on screen: where every drag ends and every resize pulls a saved spot back to. */
export function clampSpot(spot: CallCardSpot, size: { width: number; height: number }, vw: number, vh: number): CallCardSpot {
  return {
    left: Math.min(Math.max(spot.left, 0), Math.max(0, vw - size.width)),
    top: Math.min(Math.max(spot.top, 0), Math.max(0, vh - size.height)),
  };
}

/** The spot the person last dragged the card to, or null (never dragged, or a broken save). */
export function readSpot(): CallCardSpot | null {
  const raw = safeGetItem(SPOT_KEY);
  if (!raw) return null;
  try {
    const spot: unknown = JSON.parse(raw);
    // `Number.isFinite` never coerces: a string or a NaN/Infinity save reads as none.
    if (!spot || typeof spot !== 'object' || !Number.isFinite((spot as CallCardSpot).left) || !Number.isFinite((spot as CallCardSpot).top)) {
      return null;
    }
    return { left: (spot as CallCardSpot).left, top: (spot as CallCardSpot).top };
  } catch {
    return null;
  }
}

/**
 * Where the call card sits: the classes' bottom-right until the person drags it, then wherever they left it —
 * kept in localStorage across calls and reloads (a durable preference, never reclaimed). Dragging captures the
 * pointer on the card; a press on its controls (a `button` under the pointer) never starts one. Every window
 * resize pulls the saved spot back on screen. Null `spot` means "no spot yet": the card keeps its default
 * `right-4 bottom-4` classes, and the server's first paint matches, so no hydration mismatch.
 */
export function useCallCardPosition(cardRef: RefObject<HTMLElement | null>) {
  const [spot, setSpot] = useState<CallCardSpot | null>(null);
  const [dragging, setDragging] = useState(false);
  // The live spot for the drag end's save, and the drag's start state, in refs: a pointer-move
  // handler reads them without re-rendering the card's other listeners.
  const spotRef = useRef<CallCardSpot | null>(null);
  const drag = useRef<{ id: number; left: number; top: number; x: number; y: number; width: number; height: number; moved: boolean } | null>(null);

  const clamp = useCallback(
    (next: CallCardSpot): CallCardSpot => {
      const rect = cardRef.current?.getBoundingClientRect();
      // No measured box (unmounted): leave the spot alone rather than guess a size.
      if (!rect || rect.width === 0) return next;
      return clampSpot(next, { width: rect.width, height: rect.height }, window.innerWidth, window.innerHeight);
    },
    [cardRef],
  );

  const applySpot = useCallback((next: CallCardSpot | null) => {
    spotRef.current = next;
    setSpot(next);
  }, []);

  // The saved spot, once on mount: client only, after the card has its box to clamp against.
  // A layout effect on purpose: the swap lands before first paint, so the card never flashes
  // at the default corner, and the value cannot be read during render (the store starts empty
  // on the server, so the card never renders there at all).
  useLayoutEffect(() => {
    const saved = readSpot();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the value cannot be read during render (no window on the server)
    if (saved) applySpot(clamp(saved));
  }, [applySpot, clamp]);

  // A smaller window (a display change, a zoom) pulls the saved spot back on screen.
  useEffect(() => {
    const onResize = () => {
      if (spotRef.current) applySpot(clamp(spotRef.current));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applySpot, clamp]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // The controls answer presses; the card around them drags.
      if ((event.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
      const el = cardRef.current;
      if (!el || drag.current) return;
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      // Where the card sits right now (the classes' bottom-right on the first drag), and its box,
      // measured once: the drag's every move clamps against the box it started with.
      const rect = el.getBoundingClientRect();
      drag.current = {
        id: event.pointerId,
        left: rect.left,
        top: rect.top,
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
        moved: false,
      };
      setDragging(true);
    },
    [cardRef],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || event.pointerId !== d.id) return;
      d.moved = true;
      // Clamped against the box the drag started with: no layout read per move.
      applySpot(
        clampSpot(
          {
            left: d.left + (event.clientX - d.x),
            top: d.top + (event.clientY - d.y),
          },
          { width: d.width, height: d.height },
          window.innerWidth,
          window.innerHeight,
        ),
      );
    },
    [applySpot],
  );

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!drag.current || event.pointerId !== drag.current.id) return;
      const moved = drag.current.moved;
      drag.current = null;
      setDragging(false);
      // A press that never moved saves nothing: the spot on screen is the spot already saved.
      const final = spotRef.current;
      if (moved && final) safeSetItem(SPOT_KEY, JSON.stringify(final));
    },
    [],
  );

  return {
    spot,
    dragging,
    dragHandlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
  };
}
