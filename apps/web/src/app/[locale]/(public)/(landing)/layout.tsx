import { MarketingChrome } from '@/features/marketing/kit/marketing-chrome';
import { localeStaticParams } from '@/i18n/static-params';

/**
 * The home route uses the same shell as every public page: one header, one
 * footer, Roobert and one consent gate, all owned by `MarketingChrome`. The
 * route sits outside the `(marketing)` group so that group's own shell never
 * draws a second pair on the same page.
 *
 * Every locale is prerendered here. Without these params an unknown one is
 * rendered on demand and fails with "Page changed from static to dynamic at
 * runtime" (KRTX-3255).
 */
export const generateStaticParams = localeStaticParams;

export default function LandingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <MarketingChrome>{children}</MarketingChrome>;
}
