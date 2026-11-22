'use client';

/**
 * The reduced-motion hooks (`lib/reduced-motion.ts`) plus the switch's stored
 * value. The stored value reads the preferences store, a higher layer than
 * `primitives/` and `lib/`, so it stays here; everything else lives in `lib/`.
 */

import { useUserPreferencesStore } from '../stores/user-preferences-store';

export * from '../../lib/reduced-motion';

/** The switch's stored value, for the Preferences control. Legacy persisted preferences predate it: `false`. */
export function useReduceMotionSetting(): boolean {
  return useUserPreferencesStore((s) => s.preferences.reduceMotion === true);
}
