import { MarketingChrome } from '@/features/marketing/kit/marketing-chrome';
import { localeStaticParams } from '@/i18n/static-params';

// Prerender every marketing page once per locale (see i18n/static-params.ts).
export const generateStaticParams = localeStaticParams;

export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Each page keeps its own content. The chrome is the same one the home route
  // uses, so no public page can reach the retired navbar or its old home links.
  return <MarketingChrome>{children}</MarketingChrome>;
}
