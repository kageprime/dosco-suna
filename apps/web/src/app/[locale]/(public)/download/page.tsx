import { MarketingShell } from '@/app/[locale]/(public)/(marketing)/marketing-shell';
import { localizedDownloadContent } from '@/features/marketing/download/content';
import type { DesktopOs } from '@kortix/ui/internal/lib/detect-os';
import {
  DESKTOP_ORDER,
  detectPlatform,
  normalizePlatform,
} from '@kortix/ui/internal/lib/detect-os';
import { DownloadOptions } from '@/features/marketing/download/download-options';
import {
  formatSize,
  getDesktopRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';
import { getTranslations } from '@/i18n/get-translations';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/download');
}

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const [headerList, params, release, tI18nComplete] = await Promise.all([
    headers(),
    searchParams,
    getDesktopRelease(),
    getTranslations('hardcodedUi.i18nComplete'),
  ]);
  const { hero } = localizedDownloadContent(tI18nComplete);

  // The size drops out of the meta line when GitHub is unreachable. Never a
  // placeholder, never a stale number.
  const sizes: Partial<Record<DesktopOs, string>> = {};
  if (release) {
    for (const os of DESKTOP_ORDER) {
      sizes[os] = formatSize(pickDesktopAsset(release.assets, os)?.size ?? 0);
    }
  }

  return (
    <MarketingShell>
      <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col justify-center px-6 pt-28 pb-16">
        <header className="mb-10 text-center">
          <h1 className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {hero.title}
          </h1>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md text-balance">{hero.sub}</p>
        </header>

        <DownloadOptions
          detected={
            normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'))
          }
          sizes={sizes}
        />
      </main>
    </MarketingShell>
  );
}
