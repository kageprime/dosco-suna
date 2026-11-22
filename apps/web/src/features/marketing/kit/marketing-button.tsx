import { Slot } from '@kortix/ui/slot';
import { type ComponentProps } from 'react';

import { cn } from '@kortix/ui';

const SIZES = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-10 px-3.5 text-sm',
  lg: 'h-12 px-5 text-base',
} as const;

export type MarketingButtonProps = ComponentProps<'button'> & {
  /**
   * `primary` is the solid ink button (paper in dark): the main action.
   * `secondary` is the near-paper button beside it. Ink and paper only.
   */
  variant?: 'primary' | 'secondary';
  size?: keyof typeof SIZES;
  /** Render the child (a `Link`, an `a`) with the button's look. */
  asChild?: boolean;
};

/**
 * The marketing button, the "inner stroke" button. The fill, the two edge
 * rings, hover and press scale live in the `kx-button` class in globals.css;
 * this file only picks the variant and the size.
 *
 * Sizes: `sm` is for the navbar only. Every in-page button is `size="md"`
 * plus `className="hit-area-y-1"`, which grows its tap target to about 44px
 * without changing how it looks.
 */
export function MarketingButton({
  variant = 'primary',
  size = 'sm',
  asChild = false,
  className,
  ...props
}: MarketingButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-variant={variant}
      className={cn(
        'kx-button inline-flex shrink-0 items-center justify-center gap-2 rounded-[calc(var(--radius)-0.2rem)] font-medium whitespace-nowrap select-none',
        'outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
