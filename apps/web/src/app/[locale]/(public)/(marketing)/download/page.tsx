import Link from '@/components/site-link';
import { MobileCardImage } from '@/features/marketing/download/card-images';
import { localizedDownloadContent } from '@/features/marketing/download/content';
import {
  MOBILE_ORDER,
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
} from '@/features/marketing/download/detect-os';
import type { CardRow } from '@/features/marketing/download/platform-card';
import { PlatformCard } from '@/features/marketing/download/platform-card';
import { getTranslations } from '@/i18n/get-translations';
import { AndroidLogoIcon } from '@/lib/icons/ssr';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/download');
}

const MOBILE_MARKS: Record<'android', CardRow['Mark']> = {
  android: AndroidLogoIcon,
};

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const [headerList, params, tI18nComplete] = await Promise.all([
    headers(),
    searchParams,
    getTranslations('hardcodedUi.i18nComplete'),
  ]);
  const {
    hero,
    mobileCard: MOBILE_CARD,
    mobileRows: MOBILE_ROWS,
  } = localizedDownloadContent(tI18nComplete);

  const detected =
    normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'));

  const mobileRows: CardRow[] = MOBILE_ORDER.map((os) => ({
    id: os,
    label: MOBILE_ROWS[os].label,
    meta: MOBILE_ROWS[os].hint,
    href: MOBILE_ROWS[os].href,
    // Not `external` — the internal redirect route reads "Download".
    Mark: MOBILE_MARKS[os],
  }));

  const onPhone = isMobilePlatform(detected);

  const mobileCard = (
    <PlatformCard
      className="mx-auto w-full max-w-lg"
      image={<MobileCardImage />}
      title={MOBILE_CARD.title}
      description={MOBILE_CARD.description}
      rows={mobileRows}
      // A phone visitor's own platform gets the one solid button (an iPhone
      // has no APK to fill — the single row stays outline for them).
      filled={onPhone && detected === 'android' ? detected : null}
    />
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pt-28 pb-16 sm:pt-40">
      <header className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {hero.title}
        </h1>
        <p className="text-muted-foreground mx-auto mt-3 max-w-md text-balance">{hero.sub}</p>
      </header>

      {mobileCard}

      <p className="text-muted-foreground mx-auto mt-6 max-w-md text-center text-sm text-balance">
        Prefer the browser? Dosco runs at dosco.live —{' '}
        <Link href="/" className="text-foreground underline underline-offset-4 hover:no-underline">
          open the web app
        </Link>
        , nothing to install.
      </p>
    </main>
  );
}
