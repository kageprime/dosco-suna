'use client';

import { cn } from '@kortix/ui';
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

import { AsciiHoop } from './ascii-hoop';
import { HOOP_PALETTE, SEGMENTS } from './hoop-palette';

/**
 * The hula hoop, Loopmaxxing's motif: its four colors used sparingly on a
 * black and white page. A hairline, a dot, a thin ring; never a fill and
 * never on the words. The colors live in `hoop-palette.ts`; components read
 * them as CSS variables (`--hoop-0` … `--hoop-3`) that `hoopVars` sets on the
 * page wrapper.
 */
export const hoopVars = Object.fromEntries(HOOP_PALETTE.map((color, index) => [`--hoop-${index}`, color])) as CSSProperties;

/** The color for an index, cycling red, blue, green, yellow. */
export function hoop(index: number): string {
  return `var(--hoop-${((index % HOOP_PALETTE.length) + HOOP_PALETTE.length) % HOOP_PALETTE.length})`;
}

/** The word's letter-spacing: the header's small caps run wide, the big word runs tight. The O's take the same. */
const TRACKING = { wide: '0.05em', tight: '-0.025em' } as const;

/** How the wordmark draws its "OO": one infinity (the default), two hoops linked, or two hoops apart. */
export type WordmarkVariant = 'infinity' | 'linked' | 'split';
export const WORDMARK_VARIANTS: readonly WordmarkVariant[] = ['infinity', 'linked', 'split'];

/** The variant every wordmark below it draws, unless it names its own. */
export const WordmarkVariantContext = createContext<WordmarkVariant>('infinity');

/** One O of `split`: the hoop facing the reader, its tube as thick as a letter's stroke. */
const LETTER_O = { shape: 'ring', tube: 0.42 } as const;

/**
 * A letter slot: exactly the width plain text gives `letters` letters (1ch
 * each, plus the tracking between them) and 1cap tall on the baseline. The
 * hoop's canvas covers the ink box of the font's real "O"s inside it, so the
 * letters after it land where plain text puts them, at any size.
 */
function Slot({ letters, children }: { letters: 1 | 2; children: ReactNode }) {
  return (
    <span
      className="relative inline-block h-[1cap] align-baseline"
      style={{
        width: letters === 1 ? '1ch' : 'calc(2ch + var(--wordmark-tracking))',
        // Letter-spacing follows every character but never an inline box, so the slot carries it as a right margin.
        marginRight: 'var(--wordmark-tracking)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * LOOPMAXXING with its "OO" drawn by `AsciiHoop`: one infinity (the default),
 * two hoops interlocked (`linked`) or two hoops turning opposite ways (`split`).
 * Below 40 px they draw in pixel squares. Screen readers read the word.
 */
export function LoopmaxxingWordmark({
  className,
  tracking = 'tight',
  variant,
}: {
  className?: string;
  tracking?: keyof typeof TRACKING;
  variant?: WordmarkVariant;
}) {
  const fromContext = useContext(WordmarkVariantContext);
  const shown = variant ?? fromContext;
  return (
    <span
      className={cn('inline-block whitespace-nowrap', className)}
      style={{ '--wordmark-tracking': TRACKING[tracking], letterSpacing: 'var(--wordmark-tracking)' } as CSSProperties}
    >
      <span className="sr-only">Loopmaxxing</span>
      <span aria-hidden>
        L
        {shown === 'split' ? (
          <>
            <Slot letters={1}>
              <AsciiHoop {...LETTER_O} letters={1} />
            </Slot>
            <Slot letters={1}>
              <AsciiHoop {...LETTER_O} letters={1} phase={0.5} direction={-1} />
            </Slot>
          </>
        ) : (
          <Slot letters={2}>
            <AsciiHoop shape={shown} letters={2} tube={shown === 'linked' ? 0.38 : 0.3} />
          </Slot>
        )}
        PMAXXING
      </span>
    </span>
  );
}
