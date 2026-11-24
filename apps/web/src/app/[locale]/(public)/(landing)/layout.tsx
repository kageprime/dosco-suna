import { cn } from '@kortix/ui';
import type { ReactNode } from 'react';

import { roobert } from '@/app/(system)/fonts/roobert';
import { roobertMono } from '@/app/(system)/fonts/roobert-mono';
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
 *
 * The route reads in Roobert (see `.font-marketing` in globals.css), the type
 * system the loopmaxxing fold uses; the product app keeps its own stack.
 */
export const generateStaticParams = localeStaticParams;

export default function LandingLayout({ children }: Readonly<{ children: React.ReactNode }>): ReactNode {
  return (
    <div className={cn(roobert.variable, roobertMono.variable, 'font-marketing')}>
      <ConsentGate />
      {children}
    </div>
  );
}
