'use client';

import * as React from 'react';

import { Slot } from '../lib/base-ui-compat';
import { cn } from '../lib/utils';

type LabelProps = React.ComponentProps<'label'> & { asChild?: boolean };

function Label({ className, asChild, onMouseDown, ...props }: LabelProps) {
  const Comp = (asChild ? Slot : 'label') as 'label';
  return (
    <Comp
      data-slot="label"
      // Radix Label: a double click on the label does not select its text.
      onMouseDown={(event) => {
        onMouseDown?.(event);
        if (!event.defaultPrevented && event.detail > 1) event.preventDefault();
      }}
      className={cn(
        'text-muted-foreground flex cursor-pointer items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-default peer-disabled:opacity-50', // cursor-default: disabled keeps the default cursor (AGENTS.md → States)
        className,
      )}
      {...props}
    />
  );
}

export { Label };
export type { LabelProps };
