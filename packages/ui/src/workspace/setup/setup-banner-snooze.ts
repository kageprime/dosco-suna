'use client';

import { useSyncExternalStore } from 'react';

/**
 * "Later" in the setup modal snoozes the home banner for this long. The banner
 * has no dismiss of its own: the one way to quiet it is the modal it opens.
 * It comes back after the snooze while a step is still open.
 */
export const SETUP_BANNER_SNOOZE_MS = 24 * 60 * 60 * 1000;

const KEY = (projectId: string) => `kortix.setupBanner.snoozedUntil.${projectId}`;
/** Same-tab signal: `storage` events fire only in other tabs. */
const EVENT = 'kortix:setup-banner-snooze';

/** Hide the banner of this workspace, in this browser, for `SETUP_BANNER_SNOOZE_MS`. */
export function snoozeSetupBanner(projectId: string, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(KEY(projectId), String(now + SETUP_BANNER_SNOOZE_MS));
  } catch {
    // Private mode or blocked storage: the banner stays. Nothing else depends on it.
  }
  window.dispatchEvent(new Event(EVENT));
}

function snoozedUntil(projectId: string): number {
  try {
    const raw = window.localStorage.getItem(KEY(projectId));
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** True while "Later" holds the banner of this workspace. The server renders it unsnoozed. */
export function useSetupBannerSnoozed(projectId: string): boolean {
  // The snapshot is a boolean, so it stays stable between reads while the snooze holds.
  return useSyncExternalStore(
    subscribe,
    () => snoozedUntil(projectId) > Date.now(),
    () => false,
  );
}
