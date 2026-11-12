'use client';

import * as React from 'react';

import { Slot } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<'div'> & {
  orientation?: 'horizontal' | 'vertical';
  /** Purely visual: hidden from assistive tech (`role="none"`). */
  decorative?: boolean;
  asChild?: boolean;
}) {
  const { asChild, ...rest } = props;
  const Comp = (asChild ? Slot : 'div') as 'div';
  // Base UI's Separator is never decorative, so this renders the Radix contract itself.
  return (
    <Comp
      data-slot="separator"
      data-orientation={orientation}
      {...(decorative
        ? { role: 'none' }
        : {
            role: 'separator',
            'aria-orientation': orientation === 'vertical' ? ('vertical' as const) : undefined,
          })}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...rest}
    />
  );
}

export { Separator };
