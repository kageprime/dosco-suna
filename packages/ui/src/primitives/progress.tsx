'use client';

import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import * as React from 'react';

import { cn } from '../lib/utils';

function Progress({
  className,
  indicatorClassName,
  value,
  max = 100,
  getValueLabel,
  ...rest
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  value?: number | null;
  max?: number;
  getValueLabel?: (value: number, max: number) => string;
  indicatorClassName?: string;
}) {
  const state = value == null ? 'indeterminate' : value >= max ? 'complete' : 'loading';
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-state={state}
      data-value={value ?? undefined}
      data-max={max}
      value={value ?? null}
      max={max}
      getAriaValueText={getValueLabel ? (_f, v) => getValueLabel(v ?? 0, max) : undefined}
      className={cn('bg-primary/20 relative h-3 w-full overflow-hidden rounded-full', className)}
      {...rest}
    >
      {/* Base UI sizes its indicator by `width`; this one keeps the full-width slide. */}
      <div
        data-state={state}
        data-slot="progress-indicator"
        className={cn(
          'bg-primary duration-slow h-full w-full flex-1 transition-transform ease-out',
          indicatorClassName,
        )}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
