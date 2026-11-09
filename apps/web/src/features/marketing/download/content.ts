/**
 * `/download` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so copy can
 * iterate before paying the 8-locale parity gate.
 *
 * ACCURACY GATE — what this page may claim:
 *  1. macOS ships ONE universal .dmg (Apple Silicon + Intel).
 *  2. Linux desktop is x86_64 ONLY (.AppImage).
 *  3. Windows ships a 64-bit installer (.exe).
 *  4. Android ships as a direct APK (no store listing yet): the row links
 *     `/download/android`, which 302s to the current EAS artifact.
 *  5. There is no iOS build; iOS stays off the rows entirely.
 *  6. The CLI install command is displayed in the terminal block.
 */

import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import type { DesktopOs } from '@kortix/ui/internal/lib/detect-os';

export const hero = {
  title: 'Download Dosco',
  sub: 'Get the app for your desktop, your phone, or your terminal.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string };

export const DESKTOP_CARD: CardCopy = {
  title: 'Desktop app',
  description: 'Run Dosco on your own machine, with your files and your terminal.',
};

export const DESKTOP_ROWS: Record<DesktopOs, RowCopy> = {
  macos: { label: 'macOS', hint: 'Universal', href: '/download/macos' },
  windows: { label: 'Windows', hint: '64-bit', href: '/download/windows' },
  linux: { label: 'Linux', hint: 'AppImage · x86_64', href: '/download/linux' },
};

export const MOBILE_CARD: CardCopy = {
  title: 'Mobile app',
  description: 'Start a session anywhere and pick up where you left off.',
};

/**
 * `hint` is the line under the label, and it carries copy ONLY: the page never
 * invents a download size here.
 */

/** The single mobile row: the Android APK (no store listing yet - see mobile-store-urls.ts). */
export const MOBILE_ROWS: Record<'android', RowCopy> = {
  android: {
    label: 'Android',
    hint: 'APK · direct download',
    // Internal redirect route - CardRow's `external` flag reads "Download",
    // and the route 302s to the current EAS artifact.
    href: '/download/android',
  },
};

export const TERMINAL = {
  title: 'Terminal',
  description: 'Install the CLI and drive Dosco from your shell.',
  support: 'macOS & Linux · WSL on Windows',
};

export function localizedDownloadContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      desktopCard: DESKTOP_CARD,
      mobileCard: MOBILE_CARD,
      desktopRows: DESKTOP_ROWS,
      mobileRows: MOBILE_ROWS,
      terminal: TERMINAL,
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}
