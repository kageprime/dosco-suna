'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { HeroBackground, type HeroMediaMode } from '@/features/marketing/hero-background';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { HeroBand } from '@/features/marketing/kit/page-frame';
import { WorkspaceFramework } from '@/features/marketing/landing-hero/workspace-framework';
import { getLocalizedLandingContent } from '@/features/marketing/landing/content';
import { useTranslations } from '@/i18n/use-translations';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@kortix/ui';
import { HoverPrefetchLink } from '@kortix/ui/internal/components/hover-prefetch-link';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { OpenAI } from '@kortix/ui/internal/icons/open-ai';
import { type ReactNode, useState } from 'react';

/** `heroEyebrow.rivals[].icon` selects a logo by name at runtime, so it can't be
 *  statically resolved to a single import — this explicit map is the smallest set
 *  that covers it, kept in sync by hand with `landing/content.ts`. */
const RIVAL_ICONS = { Claude, OpenAI } as const;

/** Anchors the product against the two things a reader already knows, with
 *  their marks, so "CompanyOS" lands without a paragraph first. The hero reads
 *  left over the forest; `/launch` keeps the centred default. */
export function RivalEyebrow({
  content,
  align = 'center',
}: {
  content: ReturnType<typeof getLocalizedLandingContent>['heroEyebrow'];
  align?: 'center' | 'left';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    /* `justify-center` centres the wrapped rows as a unit; each rival stays its
       own inline `flex items-center` span, so the logo and its label never
       separate when the row wraps on a phone. */
    <div
      className={cn(
        'kx-hero-text text-[color:var(--hero-ink-muted)] flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm',
        align === 'center' ? 'justify-center text-center' : 'justify-start text-left',
      )}
    >
      <span>{content.lead}</span>
      {content.rivals.map((r, i) => {
        const Glyph = RIVAL_ICONS[r.icon] as ((p: { className?: string }) => ReactNode) | undefined;
        return (
          <span key={r.id} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-[color:var(--hero-ink-muted)] mr-1">
                {tI18nComplete.raw('text6201111b83a0')}
              </span>
            )}
            {Glyph ? <Glyph className="size-4" /> : null}
            <span className="text-[color:var(--hero-ink)] font-medium">{r.label}</span>
          </span>
        );
      })}
    </div>
  );
}

const Hero = () => {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero, heroEyebrow } = getLocalizedLandingContent(tI18nComplete);
  const openDemo = useRequestDemo();
  /* The fold's ink follows the media, not the theme (color.md): scene mode
     swaps in the scene-foreground pair, pending and fallback keep the theme
     pair. The swap lives in globals.css under `data-hero-media='scene'`. */
  const [media, setMedia] = useState<HeroMediaMode>('pending');

  /* The measure and the gutter belong on the same element, which is the rule the
     navbar already follows (`mx-auto w-full max-w-7xl px-6`). Splitting them —
     px-6 on the section, max-w-7xl on the inner containers — puts the padding
     outside the centred box instead of inside it, so once the viewport is wider
     than max-w-7xl the hero content starts 24px left of the navbar's and the H1
     hangs off the logo. Below max-w-7xl the two happen to agree, which is why it
     only shows on desktop. Every max-w-7xl container below therefore carries its
     own px-6. */
  return (
    <section id="hero" className="relative">
      {/* The forest copy block owns most of the fold and the navbar's dark
          scope (`data-hero-band`). The copy sits on the seam with the band, so
          the canopy reads as space above the claim and the walkthrough is the
          first thing a scroll reveals. */}
      <div
        data-hero-band
        data-hero-media={media}
        className="kx-hero-fold relative isolate flex min-h-[86svh] flex-col justify-end overflow-hidden pt-32 pb-14 sm:pt-36 sm:pb-18 lg:pb-20"
      >
        {/* Dosco Forest & Sand architectural hero backdrop. */}
        <div className="kx-hero-veil absolute inset-0 z-0" aria-hidden data-a11y-decorative>
          <HeroBackground onMediaChange={setMedia} />
        </div>

        {/* Instrument Serif displays the headline (`font-serif`), Plus Jakarta
            Sans carries the subtitle (`font-sans`), and JetBrains Mono anchors
            the trust row (`font-mono`). */}
        <div className="relative z-20 mx-auto w-full max-w-7xl px-6">
          <RivalEyebrow content={heroEyebrow} align="left" />

          <h1 className="kx-hero-text text-[color:var(--hero-ink)] mt-7 max-w-4xl font-serif text-[min(3rem,10.5vw)] leading-none font-normal tracking-tight text-balance [--kx-enter:70ms] sm:text-6xl lg:text-7xl">
            <span className="block">{hero.title}</span>
            <span className="text-[color:var(--hero-ink-muted)] block">{hero.titleMuted}</span>
          </h1>

          <p className="kx-hero-text text-[color:var(--hero-ink-muted)] mt-6 max-w-2xl font-sans text-base leading-relaxed text-pretty [--kx-enter:150ms] sm:text-lg">
            {hero.sub}
          </p>

          {/* The dark scope flips the button pair for the forest: secondary
              becomes a paper button and the accent keeps its emerald. */}
          <div
            className={cn(
              'kx-hero-text mt-8 flex flex-wrap gap-2.5 [--kx-enter:230ms]',
              media === 'scene' && 'dark',
            )}
          >
            <MarketingButton
              variant="secondary"
              size="md"
              className="hit-area-y-1"
              onClick={() => openDemo({ source: 'landing-hero' })}
            >
              {hero.ctaSecondary}
            </MarketingButton>
            <MarketingButton variant="accent" size="md" className="hit-area-y-1" asChild>
              <HoverPrefetchLink href="/auth" prefetch onClick={trackCtaSignup}>
                {hero.ctaPrimary}
              </HoverPrefetchLink>
            </MarketingButton>
          </div>

          <p className="kx-hero-text text-[color:var(--hero-ink-muted)] mt-10 font-mono text-xs tracking-wide [--kx-enter:320ms]">
            {hero.trust}
          </p>
        </div>
      </div>

      {/* Band row: hairlines top and bottom across the page, the walkthrough
          and its caption between the rails. */}
      <HeroBand caption={hero.caption} captionMuted={hero.captionMuted}>
        <div id="demo" className="relative w-full max-w-304 scroll-mt-24">
          <WorkspaceFramework />
        </div>
      </HeroBand>
    </section>
  );
};

export default Hero;
