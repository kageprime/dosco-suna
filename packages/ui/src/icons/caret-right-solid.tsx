'use client';

import type { SVGProps } from 'react';
import { cn } from '../lib/utils';

/**
 * Kortix's solid disclosure caret: Phosphor's `CaretRightIcon` (fill) drawn
 * 20% smaller inside the same 256 box, with rounder corners (radius 22 vs
 * Phosphor's 8). Same box means a drop-in swap: the caller's `size-*` and
 * `rotate-90` keep working, and the glyph reads lighter beside a label.
 *
 * Use it for every expand/collapse and "opens more" caret: the session
 * panel's section headers and rows, and the sidebar's session groups.
 */
export function CaretRightSolidIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden
      className={cn('size-4', className)}
      {...props}
    >
      <path d="M111.56,79.56L144.44,112.44Q160,128 144.44,143.56L111.56,176.44Q96,192 96,170L96,86Q96,64 111.56,79.56Z" />
    </svg>
  );
}
