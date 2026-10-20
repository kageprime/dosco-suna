import { Inter, JetBrains_Mono } from 'next/font/google';

/**
 * The type of the home landing fold, taken from the Onlook landing
 * (https://www.onlook.com, inspected 2026-10-20):
 *
 *   headline  Inter, light (300), tracking -0.04em, leading 1.04
 *   sub       Inter, regular
 *   micro     JetBrains Mono, regular
 *
 * Scoped deliberately to the home hero + the footer wordmark. The site-wide
 * stack stays Roobert (`fonts/roobert.ts`); this module only mounts the two
 * CSS variables so `hero.tsx` can address the families without forking the
 * global sans/mono tokens. Latin subset only — CJK and Cyrillic locales fall
 * back to the system stack exactly as Roobert already does.
 */
export const onlookSans = Inter({
  subsets: ['latin'],
  variable: '--font-onlook-sans',
  display: 'swap',
});

export const onlookMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-onlook-mono',
  display: 'swap',
});
