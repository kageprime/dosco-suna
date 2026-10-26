'use client';

/**
 * <BreathingCrest> — the Dosco mark, breathing.
 *
 * The crest fades between 35% and full opacity on a 950 ms ease-in-out cycle
 * and back again. It is the same motion the mobile app's loader uses
 * (`apps/mobile/components/kortix/kortix-loader.tsx`: opacity 0.35 -> 1, a
 * 950 ms in-out ease, reversed repeat), ported to the web so the two
 * products read as one.
 *
 * Where it belongs: the empty new-chat screen and the loading overlays —
 * the moments where the product is waiting on the reader. It is NOT the
 * app boot, and it is deliberately absent from the nav chrome, where an
 * idle animation would be noise rather than a signal.
 *
 * Reduced motion holds the mark at full opacity: the point of the motion is
 * to say "working", and a reader who asked for less motion should still get
 * the mark.
 */

import { m, useReducedMotion } from 'motion/react';
import { cn } from '../lib/utils';

/** The baked crest's own aspect (480x295), so the mark is never squashed. */
const CREST_ASPECT = 480 / 295;

/** One half-cycle: dim -> full. The reverse plays it back down. */
const PULSE_SECONDS = 0.95;

const DIM_OPACITY = 0.35;

export interface BreathingCrestProps {
  /** The mark's WIDTH in pixels. The height follows the crest's aspect. */
  size?: number;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export function BreathingCrest({ size = 44, className, ...props }: BreathingCrestProps) {
  const reducedMotion = useReducedMotion();

  return (
    <m.img
      src="/brand/dosco-crest.png"
      alt=""
      aria-hidden
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
      style={{ width: size, height: size / CREST_ASPECT }}
      initial={{ opacity: reducedMotion ? 1 : DIM_OPACITY }}
      animate={{ opacity: reducedMotion ? 1 : [DIM_OPACITY, 1] }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: PULSE_SECONDS,
              ease: 'easeInOut',
              repeat: Infinity,
              repeatType: 'reverse',
            }
      }
      {...props}
    />
  );
}
