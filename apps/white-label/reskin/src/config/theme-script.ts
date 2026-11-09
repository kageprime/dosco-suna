/** Lumen Workspace's light/dark choice: the storage key, the default, and the pre-paint script. */
import type { ThemeChoice } from '@kortix/white-label-shared/theme';

export type { ThemeChoice };

export const THEME_KEY = 'lumen_theme';
export const THEME_DEFAULT: ThemeChoice = 'dark';

/** Runs in <head> before the first paint, so the page never flashes the other theme. */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}')||'${THEME_DEFAULT}';var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`;
