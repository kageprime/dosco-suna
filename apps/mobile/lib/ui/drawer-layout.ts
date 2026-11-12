/**
 * drawer-layout — the project drawer's geometry (`ProjectScreen`): how wide
 * the sidebar is, how the page on top of it turns into a peek card, and where
 * a swipe may open it.
 *
 * The model is the ChatGPT iOS sidebar (Jay, 2026-11-11): the sidebar sits on
 * the plain chrome surface at the left; the page slides right as a card with
 * rounded corners and a soft shadow, and a strip of it stays visible at the
 * right edge. A tap or a swipe on that strip closes the drawer.
 *
 * Pure data: unit-tested under `bun test` (`drawer-layout.test.ts`).
 */

import { PROJECT_VIEW_ROUTE } from '@/lib/session/project-stack';

/** The sidebar's share of the window on a phone in portrait. */
export const DRAWER_WIDTH_FRACTION = 0.82;
/**
 * The widest the sidebar gets: a large phone, landscape and iPad keep a fixed
 * sidebar instead of a stretched one.
 */
export const DRAWER_MAX_WIDTH = 360;
/** The narrowest the peek strip may get, so a tap target to close always remains. */
export const DRAWER_MIN_PEEK = 56;

/**
 * The sidebar width in points for a window `windowWidth` points wide:
 * 82% of it, capped at 360, and never so wide that the peek strip drops under
 * 56pt. A 393pt iPhone gets 322 (71pt peek), a 440pt Pro Max 360 (80pt peek),
 * landscape and iPad 360.
 */
export function projectDrawerWidth(windowWidth: number): number {
  if (!(windowWidth > 0)) return 0;
  const width = Math.min(Math.round(windowWidth * DRAWER_WIDTH_FRACTION), DRAWER_MAX_WIDTH);
  return Math.max(0, Math.min(width, windowWidth - DRAWER_MIN_PEEK));
}

/**
 * The peek card's corner radius once the drawer is open: close to the
 * display corners of a current iPhone (44–55pt), so the card reads as the
 * screen itself moved aside. Android displays vary; 28 stays inside them.
 */
export const PEEK_CARD_RADIUS = { ios: 44, android: 28 } as const;
/**
 * The veil over the open card: the page's own colour at this alpha, so the
 * page's content fades toward the surface (Claude iOS; Jay, 2026-11-11). Not
 * an ink dim: a dark overlay turned the card grey beside the sidebar. The
 * card does not scale either: a smaller card left a gap that showed its
 * shadow as a band.
 */
export const PEEK_CARD_VEIL = 0.5;

export interface PeekCardFrame {
  borderRadius: number;
  /** Alpha of the page-colour veil over the card's content. */
  veil: number;
}

/**
 * The card's frame at drawer `progress` (0 closed, 1 open). Linear in
 * progress, so it tracks the finger during a swipe and the timed curve during
 * a tap. Under Reduce Motion the card does not round in motion: it takes its
 * open radius as soon as it moves; only the library's translate moves it.
 *
 * A worklet: `DrawerPeekCard` calls it on the UI thread every frame.
 */
export function peekCardFrame(progress: number, radius: number, reducedMotion: boolean): PeekCardFrame {
  'worklet';
  const p = Math.min(1, Math.max(0, progress));
  return { borderRadius: reducedMotion ? (p > 0 ? radius : 0) : p * radius, veil: p * PEEK_CARD_VEIL };
}

/**
 * How far from the left edge a rightward swipe may start to open the drawer,
 * for the project route on top (`topRoute`).
 * - Every route without horizontal scrollers: the whole page.
 * - `view` (a thread or a tool page): code blocks, tables, carousels and diffs
 *   scroll sideways, so only the left third opens the drawer. A swipe right
 *   further in scrolls that content back.
 * - `page` (a sub-page) never gets here: its left edge is the iOS swipe-back
 *   (`projectEdgeGesture`), and the drawer's swipe is off.
 */
export function drawerSwipeEdgeWidth(topRoute: string | null, windowWidth: number): number {
  if (topRoute === PROJECT_VIEW_ROUTE) return Math.round(windowWidth / 3);
  return Math.max(0, Math.round(windowWidth));
}

/**
 * While the drawer is closed, its pan activates only on a rightward move of
 * this many points and fails on a leftward one: a left swipe on the page
 * (scrolling a code block forward, a swipe action on a row) never starts the
 * drawer. Open, the library's default (5pt either way) closes it.
 */
export const DRAWER_OPEN_ACTIVATION = 12;
export const DRAWER_OPEN_FAIL_LEFT = -8;
