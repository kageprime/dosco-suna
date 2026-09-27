'use client';

import { useUserPreferencesStore } from '@/stores/user-preferences-store';

/**
 * App-wide Easy-mode lens. Reads the same `panelMode` preference the session
 * layout already honors (default `'easy'`) — one switch, every surface.
 */
export function useIsEasy(): boolean {
  return (useUserPreferencesStore((s) => s.preferences.panelMode) ?? 'easy') === 'easy';
}
