'use client';

/**
 * Reduced motion: the operating system's `prefers-reduced-motion` OR the
 * person's own "Reduce motion" switch (Settings ▸ Preferences).
 *
 * The switch is mirrored onto `<html>` as `data-reduce-motion` on workspace
 * routes only (the pre-paint script in `apps/web/src/lib/interface-themes.ts`,
 * then `ReduceMotionSync`). The attribute is the single source: marketing and
 * auth pages never carry it, so they keep their motion. Every motion path
 * reads one of these:
 *   - CSS keyframes and transitions: `theme.css` keys on the attribute, and the
 *     `motion-reduce:` / `motion-safe:` variants match it.
 *   - `motion/react`: `MotionGlobalConfig.skipAnimations`, set with the
 *     attribute. Motion reads it on every animation start, so elements that
 *     are already mounted obey a flip at once (`MotionConfig.reducedMotion`
 *     is read only when an element mounts).
 *   - Code that picks a motion branch itself: `useReducedMotion()` (React) or
 *     `prefersReducedMotion()` (a one-off check outside render).
 *
 * In workspace UI, use these instead of `useReducedMotion` from
 * `motion/react` or a raw `matchMedia(...)`: both read only the OS.
 */

import { MotionGlobalConfig } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { useUserPreferencesStore } from '../stores/user-preferences-store';

/** The `<html>` attribute set while the person's "Reduce motion" switch is on. */
export const REDUCE_MOTION_ATTRIBUTE = 'data-reduce-motion';

const SYSTEM_QUERY = '(prefers-reduced-motion: reduce)';

// The pre-paint script has already marked <html>. Seed the flag from it when
// this module loads, so Motion skips from the first mount animation on.
if (typeof document !== 'undefined' && document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE)) {
  MotionGlobalConfig.skipAnimations = true;
}

// One query object per page: `prefersReducedMotion()` runs on every layout
// change while a turn streams (`use-auto-scroll.ts`).
let systemQuery: MediaQueryList | null | undefined;
function getSystemQuery(): MediaQueryList | null {
  if (systemQuery === undefined) {
    systemQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(SYSTEM_QUERY)
        : null;
  }
  return systemQuery;
}

/** True when the OS asks for reduced motion or the person turned it on. Safe on the server (false). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE)) return true;
  return getSystemQuery()?.matches ?? false;
}

/** Mirrors the "Reduce motion" switch onto `<html>` and into Motion's global config. */
export function applyReduceMotion(element: Element, reduce: boolean): void {
  if (reduce) element.setAttribute(REDUCE_MOTION_ATTRIBUTE, '');
  else element.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
  MotionGlobalConfig.skipAnimations = reduce;
}

/** The OS setting, live: Motion's own `useReducedMotion` reads it once and never updates. */
function subscribeSystem(onChange: () => void): () => void {
  const query = getSystemQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const systemSnapshot = (): boolean => getSystemQuery()?.matches ?? false;
const serverSnapshot = (): boolean => false;

/** The switch's stored value, for the Preferences control. Legacy persisted preferences predate it: `false`. */
export function useReduceMotionSetting(): boolean {
  return useUserPreferencesStore((s) => s.preferences.reduceMotion === true);
}

/** The attribute, live: set only while the switch is on AND a workspace route is showing. */
function subscribeAttribute(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [REDUCE_MOTION_ATTRIBUTE] });
  return () => observer.disconnect();
}
const attributeSnapshot = (): boolean => document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE);

/** True while the switch applies to the current page (`data-reduce-motion` is on `<html>`). */
export function useReduceMotionActive(): boolean {
  return useSyncExternalStore(subscribeAttribute, attributeSnapshot, serverSnapshot);
}

/** Drop-in for `motion/react`'s `useReducedMotion` that also honors the switch on workspace routes. */
export function useReducedMotion(): boolean {
  const system = useSyncExternalStore(subscribeSystem, systemSnapshot, serverSnapshot);
  const active = useReduceMotionActive();
  return active || system;
}
