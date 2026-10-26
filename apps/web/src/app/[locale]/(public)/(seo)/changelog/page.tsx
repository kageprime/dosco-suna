import { localizeUiCatalog } from '@kortix/ui/i18n';
import { REMAINING_UI_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/remaining-ui-translation-keys.generated';
import { CANONICAL_ORIGIN } from '@kortix/ui/internal/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';

import { getWeeklyChangelog } from '@/features/marketing/changelog/releases';
import { WeeklyView } from '@/features/marketing/changelog/weekly-view';

const DESCRIPTION =
  'Every Dosco release, straight from the source. New features, fixes, and improvements — versioned and dated.';
const SHORT_DESCRIPTION = 'Every Dosco release, straight from the source.';

export async function generateMetadata(): Promise<Metadata> {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  return localizeUiCatalog(
    {
      title: 'Changelog',
      description: DESCRIPTION,
      openGraph: {
        title: 'Dosco Changelog',
        description: SHORT_DESCRIPTION,
        url: `${CANONICAL_ORIGIN}/changelog`,
        siteName: 'Dosco',
        type: 'website' as const,
        images: [{ url: '/banner.png', width: 1200, height: 630, alt: 'Dosco Changelog' }],
      },
      twitter: {
        card: 'summary_large_image' as const,
        title: 'Dosco Changelog',
        description: SHORT_DESCRIPTION,
        images: ['/banner.png'],
      },
      alternates: { canonical: `${CANONICAL_ORIGIN}/changelog` },
    },
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );
}

export default async function ChangelogPage() {
  const data = await getWeeklyChangelog();
  return <WeeklyView data={data} />;
}
