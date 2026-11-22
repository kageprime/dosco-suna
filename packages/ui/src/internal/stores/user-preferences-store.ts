'use client';

import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  type DarkThemeId,
  type LightThemeId,
} from '../lib/interface-theme-defaults';
import { createSafeJSONStorage } from '../lib/storage/managed-storage';
import { DEFAULT_WALLPAPER_ID } from '../../theme/wallpapers';
import type {
  CustomWallpaperConfig,
  GradientWallpaperId,
  PresetOverride,
  PresetOverrides,
} from '../../theme/wallpaper-gradients';
import { create } from 'zustand';

// A literal here for the persisted-store registry (persisted-store-coverage.test.ts reads
// it from this file); the type pins it to the key the pre-paint theme script reads.
const USER_PREFERENCES_STORE_NAME = 'kortix-user-preferences' satisfies typeof USER_PREFERENCES_STORAGE_KEY;
import { persist } from 'zustand/middleware';

// The disk key. `interface-themes.ts` interpolates the same literal into the
// no-flash boot script, and the persisted-store-coverage walker requires a
// `persist()` name it can resolve in this file — so it is declared here and
// the two copies must stay in sync (both say 'kortix-user-preferences').
const USER_PREFERENCES_STORAGE_KEY = 'kortix-user-preferences';

// ============================================================================
// Types
// ============================================================================

/** Which modifier key is used for tab switching (Cmd+1..9 or Ctrl+1..9) */
export type TabSwitchModifier = 'meta' | 'ctrl';

/** Session panel presentation: 'easy' = plain-language cards, 'advanced' = the tool stepper */
export type PanelMode = 'easy' | 'advanced';

/**
 * How much live activity the session chat shows while Dosco works.
 * 'normal' auto-expands the activity burst — steps and streaming thinking
 * text appear as they happen. 'minimal' keeps the burst collapsed to its
 * one-line summary until the user opens it.
 */
export type ConversationDensity = 'normal' | 'minimal';

export interface KeyboardShortcutPreferences {
  /** Modifier used for tab switching shortcuts (1-9) — default: 'meta' on macOS, 'ctrl' elsewhere */
  tabSwitchModifier: TabSwitchModifier;
  /** Modifier for close-tab shortcut (W) — follows tabSwitchModifier */
  closeTabModifier: TabSwitchModifier;
}

export interface UserPreferences {
  keyboard: KeyboardShortcutPreferences;
  /**
   * The palette used in light mode and in dark mode — defaults 'light'
   * and 'dark' (Kortix light / Kortix dark). The mode itself (light / dark / system) stays in
   * `next-themes`; see `lib/interface-themes.ts`. Legacy persisted preferences
   * predate these keys, so read sites go through `normalizeLightTheme` /
   * `normalizeDarkTheme`.
   */
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
  /** Selected desktop wallpaper ID */
  wallpaperId: string;
  /**
   * The user's own gradient, drawn when `wallpaperId` is 'custom'. Legacy
   * persisted preferences predate this key: read sites go through
   * `normalizeCustomWallpaper`.
   */
  customWallpaper?: CustomWallpaperConfig;
  /**
   * Colours and finish picked for a gradient preset, by preset id. Legacy
   * persisted preferences predate this key: read sites go through
   * `normalizePresetOverrides`.
   */
  wallpaperOverrides?: PresetOverrides;
  /** Session action panel mode — defaults to 'easy' for all users */
  panelMode: PanelMode;
  /**
   * Conversation density of the session chat — defaults to 'normal'.
   * Legacy persisted preferences predate this key, so read sites must use
   * `?? 'normal'` (same rule as `panelMode`).
   */
  conversationDensity: ConversationDensity;
  /**
   * Render generative UI blocks as UI (true) or as their markdown fallback (false).
   * Legacy persisted preferences predate this key: read sites use `?? true`.
   */
  genuiEnabled?: boolean;
  /**
   * Reduce motion across the app (shimmer, pulses, transitions) on top of the
   * OS setting. Legacy persisted preferences predate this key: read sites use
   * `=== true`. See `internal/hooks/use-reduced-motion.ts`.
   */
  reduceMotion?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function getDefaultKeyboardPreferences(): KeyboardShortcutPreferences {
  return {
    tabSwitchModifier: 'ctrl',
    closeTabModifier: 'ctrl',
  };
}

// ============================================================================
// Store
// ============================================================================

interface UserPreferencesState {
  preferences: UserPreferences;
  patchPreferences: (partial: Partial<UserPreferences>) => void;

  /** Update keyboard shortcut preferences (partial merge) */
  setKeyboardPreferences: (prefs: Partial<KeyboardShortcutPreferences>) => void;

  /** Set the palette used in light mode */
  setLightTheme: (theme: LightThemeId) => void;

  /** Set the palette used in dark mode */
  setDarkTheme: (theme: DarkThemeId) => void;

  /** Set the active desktop wallpaper by ID */
  setWallpaperId: (wallpaperId: string) => void;

  /** Replace the custom wallpaper's pattern, finish and colors */
  setCustomWallpaper: (customWallpaper: CustomWallpaperConfig) => void;

  /** Change a gradient preset's colours or finish; null restores it as shipped */
  setWallpaperOverride: (id: GradientWallpaperId, override: PresetOverride | null) => void;


  /** Flip between easy and advanced */
  togglePanelMode: () => void;

  /** Set the conversation density */
  setConversationDensity: (density: ConversationDensity) => void;

  /** Render generative UI blocks as UI (true) or as markdown (false) */
  setGenuiEnabled: (enabled: boolean) => void;

  /** Turn the app-wide "Reduce motion" switch on or off */
  setReduceMotion: (reduce: boolean) => void;

  /** Get the label for the current tab switch modifier (e.g. "Cmd" or "Ctrl") */
  getModifierLabel: () => string;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  keyboard: getDefaultKeyboardPreferences(),
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  wallpaperId: DEFAULT_WALLPAPER_ID,
  panelMode: 'easy',
  conversationDensity: 'normal',
  genuiEnabled: true,
  reduceMotion: false,
};

export const useUserPreferencesStore = create<UserPreferencesState>()(
  persist(
    (set, get) => ({
      preferences: DEFAULT_PREFERENCES,

      patchPreferences: (partial) => set({ preferences: { ...get().preferences, ...partial } }),

      setKeyboardPreferences: (prefs) =>
        get().patchPreferences({ keyboard: { ...get().preferences.keyboard, ...prefs } }),

      setLightTheme: (lightTheme) => get().patchPreferences({ lightTheme }),

      setDarkTheme: (darkTheme) => get().patchPreferences({ darkTheme }),

      setWallpaperId: (wallpaperId) => get().patchPreferences({ wallpaperId }),

      setCustomWallpaper: (customWallpaper) => get().patchPreferences({ customWallpaper }),

      setWallpaperOverride: (id, override) => {
        const { [id]: _removed, ...rest } = get().preferences.wallpaperOverrides ?? {};
        get().patchPreferences({ wallpaperOverrides: override ? { ...rest, [id]: override } : rest });
      },


      togglePanelMode: () => {
        const current = get().preferences;
        // Legacy users' persisted preferences predate this key entirely, so
        // `current.panelMode` can be `undefined` at runtime even though the
        // type says it can't — treat that exactly like 'easy' (every read
        // site in the app already does via `?? 'easy'`), or the toggle
        // silently writes 'easy' back and the Advanced affordance does nothing.
        const effective = current.panelMode ?? 'easy';
        get().patchPreferences({ panelMode: effective === 'easy' ? 'advanced' : 'easy' });
      },

      setConversationDensity: (density) => get().patchPreferences({ conversationDensity: density }),

      setGenuiEnabled: (enabled) => get().patchPreferences({ genuiEnabled: enabled }),

      setReduceMotion: (reduce) => get().patchPreferences({ reduceMotion: reduce }),

      getModifierLabel: () => {
        const mod = get().preferences.keyboard.tabSwitchModifier;
        return mod === 'meta' ? (isMac ? 'Cmd' : 'Win') : 'Ctrl';
      },
    }),
    {
      name: USER_PREFERENCES_STORE_NAME,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        preferences: state.preferences,
      }),
    },
  ),
);
