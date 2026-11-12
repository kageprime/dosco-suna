/**
 * Pure decisions for the PWA client (KRTX-4719), split from `pwa-client.tsx`
 * so the rules are testable without a DOM: apps/web tests run under bun.
 */

/** Chromium's installed-app display mode. iOS has no such media query. */
export const STANDALONE_QUERY = '(display-mode: standalone)';

/** One dismiss wins for the whole browser: localStorage, never a cookie. */
export const INSTALL_DISMISSED_KEY = 'kortix:pwa:install-dismissed';
export const IOS_HINT_DISMISSED_KEY = 'kortix:pwa:ios-hint-dismissed';

export type MediaQuery = { matches: boolean };
export type StorageReader = { getItem(key: string): string | null };
export type StorageWriter = { setItem(key: string, value: string): void };

/** The page runs as an installed app: Chromium's display mode or iOS's flag. */
export function isStandalone(chromiumStandalone: boolean, iosStandalone: boolean): boolean {
  return chromiumStandalone || iosStandalone;
}

/**
 * iOS Safari never fires `beforeinstallprompt`, so the one-time hint names the
 * manual path instead: Share → Add to Home Screen. iPadOS 13+ reports as Mac,
 * so a Mac user agent with touch points is an iPad.
 */
export function isIosWithoutInstallPrompt(
  userAgent: string,
  maxTouchPoints: number,
  standalone: boolean,
): boolean {
  if (standalone) return false;
  return /iP(hone|ad|od)/.test(userAgent) || (userAgent.includes('Macintosh') && maxTouchPoints > 1);
}

/** A touch-first device: no fine pointer. Phones and tablets match; a laptop with a trackpad does not. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * The floating install card is for touch devices only. On a desktop it sat
 * over the bottom-right of the app (the trigger detail panel's controls), and
 * Chromium's address bar already offers Install there.
 */
export function offersInstallCard(coarsePointer: boolean): boolean {
  return coarsePointer;
}

/** Dismissed state. Storage can throw (Safari private mode): absent, not blocked. */
export function dismissed(storage: StorageReader, key: string): boolean {
  try {
    return storage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function dismiss(storage: StorageWriter, key: string): void {
  try {
    storage.setItem(key, '1');
  } catch {
    // Safari private mode throws on setItem; the card simply returns next load.
  }
}
