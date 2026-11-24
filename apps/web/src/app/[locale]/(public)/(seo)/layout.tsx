import { MarketingChrome } from '@/features/marketing/kit/marketing-chrome';
import { localeStaticParams } from '@/i18n/static-params';

// Prerender every SEO page once per locale (see i18n/static-params.ts).
export const generateStaticParams = localeStaticParams;

export default function SeoLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <MarketingChrome>{children}</MarketingChrome>;
}
