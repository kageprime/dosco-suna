import { CaseStudies } from '@/features/marketing/case-studies/case-studies';
import { PageFrame } from '@/features/marketing/kit/page-frame';
import { SandBandHero } from '@/features/marketing/landing-hero/sand-band-hero';
import { LandingFaqSection } from '@/features/marketing/landing-sections/faq-section';
import { FrameworkBand } from '@/features/marketing/landing-sections/framework-band';
import { HowItWorksTabs } from '@/features/marketing/landing-sections/how-it-works-tabs';
import { PillarsBand } from '@/features/marketing/landing-sections/pillars-band';
import { TrustBand } from '@/features/marketing/landing-sections/trust-band';
import { UseCasesBand } from '@/features/marketing/landing-sections/use-cases-band';
import { WorksWithStrip } from '@/features/marketing/landing-sections/works-with-strip';
<<<<<<< HEAD
import { LandingFaqSection } from '@/features/marketing/landing-sections/faq-section';
import { PillarsBand } from '@/features/marketing/landing-sections/pillars-band';
import Hero from '@/features/marketing/hero';
=======
import { marketingMetadataLayout } from '@/lib/seo/metadata';

import { LandingAuthGate } from './landing-auth-gate';

const { generateMetadata } = marketingMetadataLayout('/');

export { generateMetadata };

// The home route is `/[locale]`, so it is the one route a one-segment path such
// as `/security.txt` reaches: the middleware keeps dotted paths off the locale
// rewrite. Every locale is prerendered (the marketing layout's
// `generateStaticParams`), and rendering an unknown one on demand failed with
// "Page changed from static to dynamic at runtime": a 500 on kortix.com
// (KRTX-3255). An unknown value is a 404 without a render, as in
// `solutions/[role]`.
export const dynamicParams = false;
>>>>>>> upstream/dev

/**
 * Dosco landing page:
 * 1. Hero: dynamic ambient fold with Dosco brand proposition.
 * 2. Section bands: Works with, Pillars, How it works, Framework, Use cases, Trust & FAQ.
 */
export default function Home() {
  return (
<<<<<<< HEAD
    <div className="bg-background relative w-full">
      <Hero />
      <main className="bg-background relative mx-auto w-full max-w-[1440px]">
        {/* Rails: 62px in from each edge on the board. z-10 keeps them above the band fill. */}
        <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17" />
        <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17" />
        <WorksWithStrip />
      <CaseStudies />
=======
    <LandingAuthGate>
      <PageFrame>
        <SandBandHero />
        <WorksWithStrip />
        <CaseStudies />
>>>>>>> upstream/dev
        <PillarsBand />
        {/* ProblemSolution ("Your know-how is everywhere.") is stashed: hidden
            from the home page by founder call, 2026-10-27; the component stays. */}
        <HowItWorksTabs />
        <FrameworkBand />
        <UseCasesBand />
        <TrustBand />
        <LandingFaqSection />
<<<<<<< HEAD
      </main>
    </div>
=======
      </PageFrame>
    </LandingAuthGate>
>>>>>>> upstream/dev
  );
}
