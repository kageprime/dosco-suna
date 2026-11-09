'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Light, dark or the system setting, remembered in this browser. The class on
 * <html> is set before the first paint by the host app's pre-paint script
 * (its `THEME_SCRIPT`), so the page never flashes the other theme.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

function apply(choice: ThemeChoice) {
  const dark =
    choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** `key` is the host app's storage key; `defaultChoice` its pre-paint default. */
export function useTheme({ key, defaultChoice }: { key: string; defaultChoice: ThemeChoice }) {
  const [choice, setState] = useState<ThemeChoice>(defaultChoice);
  useEffect(() => {
    try {
      setState((localStorage.getItem(key) as ThemeChoice | null) ?? defaultChoice);
    } catch {
      // Storage blocked: keep the default.
    }
  }, [key, defaultChoice]);
  const setChoice = useCallback(
    (next: ThemeChoice) => {
      setState(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Storage blocked: the choice lasts for this page only.
      }
      apply(next);
    },
    [key],
  );
  return { choice, setChoice };
}
