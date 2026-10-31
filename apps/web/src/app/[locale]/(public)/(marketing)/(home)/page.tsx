import { FrameworkBand } from '@/features/marketing/landing-sections/framework-band';
import { CaseStudies } from '@/features/marketing/case-studies/case-studies';
import { isServicesPagesEnabled } from '@/lib/config';
import { HowItWorksTabs } from '@/features/marketing/landing-sections/how-it-works-tabs';
import { TrustBand } from '@/features/marketing/landing-sections/trust-band';
import { UseCasesBand } from '@/features/marketing/landing-sections/use-cases-band';
import { WorksWithStrip } from '@/features/marketing/landing-sections/works-with-strip';
import { LandingFaqSection } from '@/features/marketing/landing-sections/faq-section';
import { PillarsBand } from '@/features/marketing/landing-sections/pillars-band';
import Hero from '@/features/marketing/hero';

/**
 * Dosco landing page:
 * 1. Hero: dynamic ambient fold with Dosco brand proposition.
 * 2. Section bands: Works with, Pillars, How it works, Framework, Use cases, Trust & FAQ.
 */
export default function Home() {
  return (
    <div className="bg-background relative w-full">
      <Hero />
      <main className="bg-background relative mx-auto w-full max-w-[1440px]">
        {/* Rails: 62px in from each edge on the board. z-10 keeps them above the band fill. */}
        <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17" />
        <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17" />
        <WorksWithStrip />
        {/* Case studies ship with /services and /case-studies (SERVICES_PAGES_ENABLED). */}
        {isServicesPagesEnabled() ? <CaseStudies allLink /> : null}
        <PillarsBand />
        {/* ProblemSolution ("Your know-how is everywhere.") is stashed: hidden
            from the home page by founder call, 2026-10-27; the component stays. */}
        <HowItWorksTabs />
        <FrameworkBand />
        <UseCasesBand />
        <TrustBand />
        <LandingFaqSection />
      </main>
    </div>
  );
}
