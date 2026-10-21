/**
 * `/download` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so copy can
 * iterate before paying the 8-locale parity gate. Same precedent as
 * `features/marketing/self-hosted/content.ts`.
 *
 * ACCURACY GATE - what this page may claim:
 *  1. The product surfaces are the WEB APP (dosco.live - nothing to install)
 *     and the Android APK. There is no desktop app (Windows/macOS/Linux) and
 *     the page must not advertise one, not even as "coming soon".
 *  2. Android ships as a direct APK (no store listing yet): the row links
 *     `/download/android`, which 302s to the current EAS artifact - see
 *     MOBILE_ROWS and mobile-store-urls.ts.
 *  3. There is no iOS build; iOS stays off the rows entirely.
 *  4. There is no Chrome extension in this repo - no manifest, no app. The
 *     page must not advertise one, not even as "coming soon".
 *  5. The CLI redirect routes (`/download/cli/<target>`) still answer for
 *     terminal users, but the page no longer advertises them.
 */

import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

export const hero = {
  title: 'Download Dosco',
  sub: 'Get the app on your phone, or use Dosco right in your browser.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string };

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

export function localizedDownloadContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      mobileCard: MOBILE_CARD,
      mobileRows: MOBILE_ROWS,
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}
