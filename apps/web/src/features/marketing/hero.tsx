'use client';

import { HeroBackground, type HeroMediaMode } from '@/features/marketing/hero-background';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { OpenAI } from '@kortix/ui/internal/icons/open-ai';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { getLocalizedLandingContent } from '@/features/marketing/landing/content';
import { useTranslations } from '@/i18n/use-translations';
import { type ReactNode, useState } from 'react';

/** `heroEyebrow.rivals[].icon` selects a logo by name at runtime, so it can't be
 *  statically resolved to a single import — this explicit map is the smallest set
 *  that covers it, kept in sync by hand with `landing/content.ts`. */
const RIVAL_ICONS = { Claude, OpenAI } as const;

/** Anchors the product against the two things a reader already knows, with
 *  their marks, so "AI Operating System" lands without a paragraph first. */
export function RivalEyebrow({
  content,
}: {
  content: ReturnType<typeof getLocalizedLandingContent>['heroEyebrow'];
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    /* `justify-center` centres the wrapped rows as a unit; each rival stays its
       own inline `flex items-center` span, so the logo and its label never
       separate when the row wraps on a phone. */
    <div className="kx-hero-text text-[color:var(--hero-ink-muted)] flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-center text-sm">
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
    /* The hero owns a full viewport and centres inside it. Before this it was
       simply padded from the top, so on a tall display the block finished with
       ~300px of dead space under it while the eyebrow still sat ~30px below the
       navbar — top-heavy and cramped at the same time. `min-h-svh` plus
       `justify-center` splits the slack above and below instead, and the top
       padding is the floor that keeps the eyebrow clear of the fixed navbar
       (67px) at every height. */
    <section
      id="hero"
      className="relative flex min-h-svh flex-col justify-center overflow-hidden pt-32 pb-12 sm:pt-36 sm:pb-16 lg:pt-32 lg:pb-14"
    >
      {/* The flowing gradient behind the fold, full-bleed edge to edge. It was
          the brandmark veil behind a `mask-t-from-70%` top fade; the fade
          exposed the page background above the canvas — a white band over the
          colourful scene in light mode (reported 2026-10-20). The navbar is
          solid `bg-background`, so the scene needs no fade under it. The Unicorn
          scene (hero-background.tsx) renders on every viewport and holds the
          brandmark itself as the reduced-motion and WebGL fallback. */}
      <div
        className="kx-hero-veil inset-0 z-0 absolute"
        aria-hidden
        data-a11y-decorative
      >
        <HeroBackground onMediaChange={setMedia} />
      </div>

      {/* The fold is type only. Families are scoped through the Inter /
          JetBrains Mono variables mounted in fonts/onlook.ts; the site-wide
          Roobert stack is untouched. Class values are Onlook's live h1
          treatment (light 300, -0.04em, 1.04 leading, text-balance,
          min(2.25rem, 9vw) on phones up to text-6xl). */}
      {/* Four bands enter in reading order — eyebrow → headline → sub → trust —
          each with its own delay and its own distance. Delays are Tailwind
          arbitrary properties, not inline styles. Both the keyframes and the
          reduced-motion fallback live in globals.css, and an inline
          `animation-delay` would outrank the stylesheet and keep the staged
          reveal alive after prefers-reduced-motion removed the travel. Setting
          only `--kx-enter` leaves the stylesheet free to zero it. */}
      {/* The fold's ink follows the media (color.md, scene-foreground tokens):
          `kx-hero-fold` + `data-hero-media` let globals.css swap the theme ink
          pair for the scene pair once the scene owns the surface; SSR and the
          fallback wallpaper keep the theme ink. */}
      <div className="kx-hero-fold relative z-20" data-hero-media={media}>
        <div className="mx-auto w-full max-w-7xl px-6">
          <RivalEyebrow content={heroEyebrow} />

          {/* `mx-auto` on the measure is what actually centres the block: without
              it `max-w-3xl` stays flush left inside max-w-7xl and only the glyphs
              inside it centre, which leaves the headline off-axis on desktop. */}
          <h1 className="kx-hero-text text-[color:var(--hero-ink)] mx-auto mt-5 max-w-3xl text-center font-[family-name:var(--font-onlook-sans)] text-[min(2.25rem,9vw)] leading-[1.04] font-light tracking-[-0.04em] text-balance [--kx-enter:70ms] sm:text-6xl">
            {hero.title}
          </h1>

          {/* One centred line under the headline. It held the sub/actions row
              and then the deliverable cards; the fold is type only now, so the
              wrapper is just the single line. */}
          <div className="mt-6 flex flex-col items-center">
            <p className="kx-hero-text text-[color:var(--hero-ink-muted)] mx-auto max-w-xl text-center font-[family-name:var(--font-onlook-sans)] text-base leading-relaxed text-balance [--kx-enter:150ms] sm:text-lg">
              {hero.sub}
            </p>
          </div>
        </div>

        <p className="kx-hero-text text-[color:var(--hero-ink-muted)] mx-auto mt-10 max-w-7xl px-6 text-center font-[family-name:var(--font-onlook-mono)] text-[11px] tracking-wide [--kx-enter:490ms]">
          {hero.trust}
        </p>
      </div>
    </section>
  );
};

export default Hero;
