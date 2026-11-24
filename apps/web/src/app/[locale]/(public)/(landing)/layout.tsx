import { ConsentGate } from '@/components/consent-gate';
import { localeStaticParams } from '@/i18n/static-params';

/**
 * The landing owns its own shell: one header and one footer, both drawn by the
 * page. It sits outside the `(marketing)` group so that group's MarketingShell
 * (navbar + footer) does not render a second pair on the same route.
 *
 * Every locale is prerendered here, as it was in the marketing layout. Without
 * these params an unknown one is rendered on demand and fails with "Page
 * changed from static to dynamic at runtime" (KRTX-3255).
 */
export const generateStaticParams = localeStaticParams;

export default function LandingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <ConsentGate />
      {children}
    </>
  );
}
