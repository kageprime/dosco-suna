'use client';

import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  FULL_COLOR_LOGOS,
  WORKS_WITH,
} from '@/features/marketing/landing-sections/works-with-logos';
import { cn } from '@kortix/ui';
import { DitherField } from '@/features/marketing/kit/dither-field';

/** The three lines the pane cycles through, in order. Keys under `auth.story`. */
const LINES = ['outcome', 'repo', 'approve'] as const;

/** Time each line holds on screen before the next one replaces it. */
const HOLD_MS = 5200;
/** Tailwind's `lg`: the frame shows the pane from here up. */
const WIDE = '(min-width: 64rem)';
const EASE = [0.23, 1, 0.32, 1] as const;
const noop = () => () => {};
const KATAKANA = /[\p{Script=Katakana}ー]/u;

/**
 * Apps the agents connect to, for the strip at the bottom of the pane.
 * Capabilities, not customers: the same rule as the landing works-with strip.
 */
const STRIP_SLUGS = [
  'slack',
  'github',
  'notion',
  'linear',
  'gmail',
  'googledrive',
  'figma',
  'hubspot',
  'salesforce',
  'stripe',
  'jira',
] as const;
const STRIP = STRIP_SLUGS.map((slug) => WORKS_WITH.find((logo) => logo.slug === slug)).filter(
  (logo): logo is (typeof WORKS_WITH)[number] => Boolean(logo),
);

/**
 * A line cut into words for the locale, each carrying the spaces and
 * punctuation after it. Japanese and Chinese have no spaces, so a split on
 * " " would make one unbreakable chunk; the segmenter finds their words, and
 * the line can wrap between any two chunks.
 */
function splitWords(text: string, locale: string): string[] | null {
  // Firefox before 125 has no Intl.Segmenter: the line renders as plain text
  // and wraps by the browser's own rules.
  if (typeof Intl.Segmenter !== 'function') return null;
  const chunks: string[] = [];
  for (const { segment, isWordLike } of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
    const last = chunks[chunks.length - 1];
    // The segmenter cuts long katakana words (リ・ポジ・トリ): keep a katakana
    // run whole so it never wraps mid-word.
    const katakanaRun = last !== undefined && KATAKANA.test(last.at(-1) ?? '') && KATAKANA.test(segment[0]);
    if ((isWordLike && !katakanaRun) || last === undefined) chunks.push(segment);
    else chunks[chunks.length - 1] += segment;
  }
  return chunks;
}

/**
 * Per-word motion. A word enters from a soft blur, a fraction of an em low,
 * on a strong ease-out; the next word follows 35ms later, so the line reads
 * in as one gesture. The whole line leaves at once, faster than it came:
 * nobody waits for an exit. Reduced motion keeps only a quick fade.
 */
const WORD = {
  hidden: { opacity: 0, y: '0.3em', filter: 'blur(8px)' },
  shown: {
    opacity: 1,
    y: '0em',
    filter: 'blur(0px)',
    transition: { duration: 0.5, ease: EASE },
  },
  gone: {
    opacity: 0,
    y: '-0.15em',
    filter: 'blur(6px)',
    transition: { duration: 0.2, ease: EASE },
  },
};
const WORD_STILL = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.2 } },
  gone: { opacity: 0, transition: { duration: 0.15 } },
};
const LINE = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.035 } },
  // Every word exits together.
  gone: { transition: { staggerChildren: 0 } },
};
const HEADLINE_CLASS =
  'text-foreground text-3xl font-medium tracking-tight text-balance xl:text-4xl';

/** One headline. Plain text where the browser cannot split words. */
function Headline({ text, still }: { text: string; still: boolean }) {
  const locale = useLocale();
  const words = useMemo(() => splitWords(text, locale), [text, locale]);
  const word = still ? WORD_STILL : WORD;
  if (!words) {
    return (
      <m.p className={HEADLINE_CLASS} initial="hidden" animate="shown" exit="gone" variants={word}>
        {text}
      </m.p>
    );
  }
  return (
    <m.p className={HEADLINE_CLASS} initial="hidden" animate="shown" exit="gone" variants={LINE}>
      {words.map((chunk, index) => {
        const glyphs = chunk.trimEnd();
        // The space after a word stays a plain text node, so a wrapped line
        // drops it at the break and stays on the centre axis.
        return (
          // Words repeat across a line ("and", "you"): the index keeps keys unique.
          <Fragment key={`${chunk}-${index}`}>
            <m.span className="inline-block" variants={word}>
              {glyphs}
            </m.span>
            {chunk.slice(glyphs.length)}
          </Fragment>
        );
      })}
    </m.p>
  );
}

/**
 * A logo tile: the brand's own colour mark where one ships in
 * public/media/landing/logos/color, else its glyph in ink (the near-black
 * brands, GitHub and Notion, whose real mark is ink).
 */
function LogoTile({ logo }: { logo: (typeof WORKS_WITH)[number] }) {
  return (
    <li className="bg-popover flex shrink-0 items-center gap-2.5 rounded-md px-5 py-3">
      {FULL_COLOR_LOGOS.has(logo.slug) ? (
        // eslint-disable-next-line @next/next/no-img-element -- a 20px static SVG; next/image adds nothing here
        <img
          src={`/media/landing/logos/color/${logo.slug}.svg`}
          alt=""
          aria-hidden
          decoding="async"
          loading="lazy"
          className="size-5 shrink-0 object-contain"
        />
      ) : (
        <span
          aria-hidden
          className="bg-foreground size-5 shrink-0"
          style={{
            maskImage: `url(/media/landing/logos/${logo.slug}.svg)`,
            maskSize: 'contain',
            maskRepeat: 'no-repeat',
            maskPosition: 'center',
          }}
        />
      )}
      <span className="text-foreground text-base font-medium whitespace-nowrap">{logo.name}</span>
    </li>
  );
}

/**
 * The story half of the sign-in frame, left of the form on wide screens: one
 * line about what Kortix does, swapped every few seconds, and a slow strip of
 * the apps the agents work in. Reduced motion holds the first line and stops
 * the strip.
 */
export function AuthStoryPane({ className }: { className?: string }) {
  const t = useTranslations('auth.story');
  const reduceMotion = useReducedMotion() ?? false;
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    // A window without matchMedia (a test DOM) holds the first line.
    if (reduceMotion || typeof window.matchMedia !== 'function') return;
    // The pane is display:none below lg; rotate only while it shows.
    const wide = window.matchMedia(WIDE);
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      timer = wide.matches
        ? setInterval(() => setIndex((i) => (i + 1) % LINES.length), HOLD_MS)
        : undefined;
    };
    sync();
    wide.addEventListener('change', sync);
    return () => {
      clearInterval(timer);
      wide.removeEventListener('change', sync);
    };
  }, [reduceMotion]);

  const line = t(LINES[index]);

  return (
    <aside
      className={cn('bg-muted/60 relative flex h-svh flex-col overflow-hidden', className)}
      aria-label={t('label')}
    >
      {/* The landing footer CTA's dither band: the same field, height and
          two-layer mask, so it fades out well above the headline. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-81.5 [mask-image:linear-gradient(to_bottom,#000,transparent_150px),radial-gradient(50%_300px_at_50%_0,#000,transparent)]"
        aria-hidden
      >
        <DitherField className="text-kortix-base" />
      </div>
      {/* Centred on the whole pane, as the strip below is pinned to its foot. */}
      <div className="absolute inset-0 flex items-center justify-center px-12 xl:px-20">
        <div className="relative w-full max-w-[520px] text-center">
          {/* Every line, stacked and hidden, sets the height: the pane never
              jumps when a short line replaces a long one. */}
          <div aria-hidden className="invisible grid">
            {LINES.map((key) => (
              <p
                key={key}
                className={cn(HEADLINE_CLASS, 'col-start-1 row-start-1')}
              >
                {t(key)}
              </p>
            ))}
          </div>
          <div aria-live="off" className="absolute inset-0 flex items-center justify-center">
            {/* Client only: the word split depends on the browser's
                Intl.Segmenter, so the server never renders the spans and
                hydration cannot disagree. The sizer above holds the space. */}
            {hydrated ? (
              <AnimatePresence mode="wait">
                <Headline key={LINES[index]} text={line} still={reduceMotion} />
              </AnimatePresence>
            ) : null}
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-10 [@media(max-height:35rem)]:hidden">
        <p className="text-muted-foreground mb-4 text-center text-sm">{t('worksWith')}</p>
        {/* audit:allow --duration is the loop period of the marquee keyframes, not a transition. */}
        <div
          className="group flex gap-(--gap) overflow-hidden [--duration:60s] [--gap:2rem] [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]"
          aria-hidden
        >
          {[0, 1].map((copy) => (
            <ul
              key={copy}
              className={cn(
                'flex shrink-0 gap-(--gap)',
                // motion-safe: follows a reduced-motion switch made while the page is open.
                'motion-safe:animate-marquee group-hover:[animation-play-state:paused]',
              )}
            >
              {STRIP.map((logo) => (
                <LogoTile key={logo.slug} logo={logo} />
              ))}
            </ul>
          ))}
        </div>
        {/* The strip is decorative; a screen reader gets the list once, as text. */}
        <p className="sr-only">{STRIP.map((logo) => logo.name).join(', ')}</p>
      </div>
    </aside>
  );
}
