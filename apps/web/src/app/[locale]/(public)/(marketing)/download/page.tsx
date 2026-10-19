import { AppleMark, LinuxMark, PlayStoreMark, WindowsMark } from '@/components/brand/brand-logos';
import { DesktopCardImage, MobileCardImage } from '@/features/marketing/download/card-images';
<<<<<<< HEAD:apps/web/src/app/[locale]/(public)/download/page.tsx
import { DownloadCloseButton } from '@/features/marketing/download/close-button';
import { DESKTOP_STATUS, localizedDownloadContent } from '@/features/marketing/download/content';
=======
import { localizedDownloadContent } from '@/features/marketing/download/content';
>>>>>>> upstream-dev:apps/web/src/app/[locale]/(public)/(marketing)/download/page.tsx
import type { DesktopOs, MobileOs, Platform } from '@/features/marketing/download/detect-os';
import {
  DESKTOP_ORDER,
  MOBILE_ORDER,
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
} from '@/features/marketing/download/detect-os';
import type { CardRow } from '@/features/marketing/download/platform-card';
import { PlatformCard } from '@/features/marketing/download/platform-card';
import { TerminalBlock } from '@/features/marketing/download/terminal-block';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { getTranslations } from '@/i18n/get-translations';
import { headers } from 'next/headers';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/download');
}

const DESKTOP_MARKS: Record<DesktopOs, CardRow['Mark']> = {
  macos: AppleMark,
  windows: WindowsMark,
  linux: LinuxMark,
};

const MOBILE_MARKS: Record<MobileOs, CardRow['Mark']> = {
  ios: AppleMark,
  android: PlayStoreMark,
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
    desktopCard: DESKTOP_CARD,
    mobileCard: MOBILE_CARD,
    desktopRows: DESKTOP_ROWS,
    mobileRows: MOBILE_ROWS,
  } = localizedDownloadContent(tI18nComplete);

  const detected: Platform =
    normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'));

<<<<<<< HEAD:apps/web/src/app/[locale]/(public)/download/page.tsx
  const desktopRows: CardRow[] = orderedDesktop(detected).map((os) => ({
    id: os,
    label: DESKTOP_ROWS[os].label,
    meta: DESKTOP_ROWS[os].hint,
    status: DESKTOP_STATUS,
    Mark: DESKTOP_MARKS[os],
  }));
=======
  const desktopRows: CardRow[] = DESKTOP_ORDER.map((os) => {
    const size = release ? formatSize(pickDesktopAsset(release.assets, os)?.size ?? 0) : '';
    return {
      id: os,
      label: DESKTOP_ROWS[os].label,
      // The size drops out of the join when GitHub is unreachable, leaving just
      // the copy. Never a placeholder, never a stale number.
      meta: [DESKTOP_ROWS[os].hint, size].filter(Boolean).join(' · '),
      href: DESKTOP_ROWS[os].href,
      Mark: DESKTOP_MARKS[os],
    };
  });
>>>>>>> upstream-dev:apps/web/src/app/[locale]/(public)/(marketing)/download/page.tsx

  const mobileRows: CardRow[] = MOBILE_ORDER.map((os) => ({
    id: os,
    label: MOBILE_ROWS[os].label,
    meta: MOBILE_ROWS[os].hint,
    href: MOBILE_ROWS[os].href,
    external: true,
    Mark: MOBILE_MARKS[os],
  }));

  const onPhone = isMobilePlatform(detected);

  const desktopCard = (
    <PlatformCard
      image={<DesktopCardImage />}
      title={DESKTOP_CARD.title}
      description={DESKTOP_CARD.description}
      rows={desktopRows}
      filled={onPhone ? null : detected}
    />
  );

  const mobileCard = (
    <PlatformCard
      // Desktop sits left and Mobile right at md+, always. On the stacked phone
      // layout a phone visitor sees the Mobile card first.
      className={onPhone ? 'order-first md:order-none' : undefined}
      image={<MobileCardImage />}
      title={MOBILE_CARD.title}
      description={MOBILE_CARD.description}
      rows={mobileRows}
      // A phone visitor's own store gets the one solid button.
      filled={onPhone ? detected : null}
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

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {desktopCard}
          {mobileCard}
        </div>
        <TerminalBlock />
      </div>
    </main>
  );
}
