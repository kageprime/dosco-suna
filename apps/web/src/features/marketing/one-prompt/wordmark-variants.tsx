'use client';

import { cn } from '@kortix/ui';
import Link from 'next/link';

import { LoopmaxxingWordmark, WORDMARK_VARIANTS, type WordmarkVariant } from './hoop';
import { useForceDarkPage } from './parts';

/** What each variant draws in the "OO". */
const NAMES: Record<WordmarkVariant, string> = {
  infinity: 'Infinity (default): one tube along ∞, passing over itself',
  linked: 'Linked: two hoops interlocked like chain links',
  split: 'Split: two hoops, turning opposite ways',
};

/** The sizes the wordmark appears at: the header's, a mid size, and the giant closing line. */
const SIZES = [
  { label: 'Header, 14 px', className: 'text-sm', tracking: 'wide' as const, spacing: '0.05em' },
  { label: '48 px', className: 'text-5xl', tracking: 'tight' as const, spacing: '-0.025em' },
  { label: 'Closing line, 13.6% of the width', className: 'text-[13.6cqi]', tracking: 'tight' as const, spacing: '-0.025em' },
];

/**
 * The wordmark's three variants side by side at every size they appear at,
 * each above the plain word in the same font, so their letters can be checked
 * against plain text by eye. /loopmaxxing?wordmark=… shows one in place.
 */
export function WordmarkVariants() {
  useForceDarkPage();
  return (
    <div className="dark bg-background text-foreground min-h-screen [color-scheme:dark]">
      <div className="mx-auto flex max-w-7xl flex-col gap-24 px-6 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">LOOPMAXXING wordmark: three variants</h1>
          <p className="text-muted-foreground text-sm">Each size: the variant, then the plain word in the same font. See one in place:</p>
          <p className="flex flex-wrap gap-4 text-sm">
            {WORDMARK_VARIANTS.map((variant) => (
              <Link key={variant} href={`/loopmaxxing?wordmark=${variant}`} className="text-muted-foreground hover:text-foreground underline transition-colors">
                /loopmaxxing?wordmark={variant}
              </Link>
            ))}
          </p>
        </header>
        {WORDMARK_VARIANTS.map((variant) => (
          <section key={variant} className="flex flex-col gap-10">
            <h2 className="text-muted-foreground text-sm">{NAMES[variant]}</h2>
            {SIZES.map((size) => (
              <div key={size.label} className="@container flex flex-col gap-3">
                <span className="text-muted-foreground text-xs">{size.label}</span>
                <div className={cn('font-mono leading-none font-medium uppercase', size.className)}>
                  <LoopmaxxingWordmark variant={variant} tracking={size.tracking} />
                </div>
                <div className={cn('text-muted-foreground font-mono leading-none font-medium whitespace-nowrap uppercase', size.className)} style={{ letterSpacing: size.spacing }}>
                  LOOPMAXXING
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
