/**
 * `/download` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so copy can
 * iterate before paying the 8-locale parity gate. Same precedent as
 * `features/marketing/self-hosted/content.ts`.
 *
 * ACCURACY GATE — every string below is checked against the live GitHub release
 * (v0.11.0, 2026-07-28), not against docs:
 *  1. macOS ships ONE universal .dmg. Never advertise separate Apple Silicon
 *     and Intel desktop builds — they do not exist.
 *  2. Linux desktop is x86_64 ONLY. There is no arm64 AppImage. The row says so
 *     rather than letting an ARM visitor download a binary that will not run.
 *  3. There is NO Windows CLI binary. The install script is bash-only, so the
 *     terminal block says "macOS & Linux · WSL on Windows".
 *  4. There is no Chrome extension in this repo — no manifest, no app. The page
 *     must not advertise one, not even as "coming soon".
 *  5. The mobile apps are UNPUBLISHED: the current store listings belong to
 *     the legacy Kortix apps. The store URLs are null (`mobile-store-urls.ts`),
 *     so the page renders no mobile card and no store row. Fill the URLs back
 *     in when the Dosco apps are ported and the card returns on its own.
 */

import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import type { DesktopOs, MobileOs } from './detect-os';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from './mobile-store-urls';

export const hero = {
  title: 'Download Dosco',
  sub: 'Get the app for your desktop or your terminal.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string | null };

export const DESKTOP_CARD: CardCopy = {
  title: 'Desktop app',
  description: 'Run Dosco on your own machine, with your files and your terminal.',
};

export const MOBILE_CARD: CardCopy = {
  title: 'Mobile app',
  description: 'Start a session anywhere and pick up where you left off.',
};

/**
 * `hint` is the line under the label, and it carries copy ONLY. The live
 * download size is appended at render from the GitHub release, so when that API
 * is unreachable the size disappears instead of printing a stale or invented
 * number.
 */
export const DESKTOP_STATUS = 'Coming soon';

export const DESKTOP_ROWS: Record<DesktopOs, ComingSoonRowCopy> = {
  macos: { label: 'macOS', hint: 'Universal' },
  windows: { label: 'Windows', hint: '64-bit' },
  linux: { label: 'Linux', hint: 'AppImage · x86_64' },
};

/** Store URLs live in `mobile-store-urls.ts`; nulls mean the listing is not published. */
export const MOBILE_ROWS: Record<MobileOs, RowCopy> = {
  ios: {
    label: 'iPhone and iPad',
    hint: 'App Store',
    href: APP_STORE_URL,
  },
  android: {
    label: 'Android',
    hint: 'Google Play',
    href: GOOGLE_PLAY_URL,
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
