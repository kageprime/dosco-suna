'use client';

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import * as React from 'react';

import { cn } from '../lib/utils';
import Hint from './hint';
import type { SliderRootProps } from './slider';

// `has-focus-visible`: the thumb's focusable node is its hidden range input.
const thumb = (index: number) => (
  <SliderPrimitive.Thumb
    data-slot="slider-thumb"
    index={index}
    className="border-ring ring-ring/50 hit-area-4 relative block size-3.5 shrink-0 rounded-full border bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 has-focus-visible:ring-3 data-disabled:pointer-events-none data-disabled:opacity-50"
  />
);

const asArray = (value: number | readonly number[]) =>
  (Array.isArray(value) ? [...value] : [value as number]) as number[];

function NativeSlider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  tooltip,
  onValueChange,
  onValueCommit,
  minStepsBetweenThumbs,
  inverted: _inverted,
  orientation,
  ...props
}: SliderRootProps & {
  /** Shown in a Hint above the thumb while hovering it. */
  tooltip?: React.ReactNode;
}) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      orientation={orientation}
      data-orientation={orientation ?? 'horizontal'}
      minStepsBetweenValues={minStepsBetweenThumbs}
      onValueChange={onValueChange ? (next) => onValueChange(asArray(next)) : undefined}
      onValueCommitted={onValueCommit ? (next) => onValueCommit(asArray(next)) : undefined}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...(props as Omit<typeof props, 'ref'>)}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full grow items-center data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="bg-kortix-base/60 relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-kortix-blue absolute select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => {
          if (tooltip == null) return <React.Fragment key={index}>{thumb(index)}</React.Fragment>;
          return (
            <Hint key={index} side="top" label={tooltip}>
              {thumb(index)}
            </Hint>
          );
        })}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { NativeSlider };
