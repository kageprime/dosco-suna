'use client';

/**
 * <BreathingCrest> — the Dosco fiery mark loader.
 *
 * Renders the transparent fiery animated brand loader (/brand/dosco-loader.webp).
 * For reduced motion, gracefully falls back to the static brand mark.
 */

import { useReducedMotion } from 'motion/react';
import { cn } from '../lib/utils';
import type { ComponentPropsWithoutRef } from 'react';

export interface BreathingCrestProps extends ComponentPropsWithoutRef<'img'> {
  /** The mark's size in pixels (square aspect ratio). */
  size?: number;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export function BreathingCrest({ size = 44, className, ...props }: BreathingCrestProps) {
  const reducedMotion = useReducedMotion();

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={reducedMotion ? '/brand/dosco-crest.png' : '/brand/dosco-loader.webp'}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('shrink-0 select-none object-contain', className)}
      style={{ width: `${size}px`, height: `${size}px` }}
      {...props}
    />
  );
}
