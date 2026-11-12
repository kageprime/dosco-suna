'use client';

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import * as React from 'react';

import { cn } from '../lib/utils';

/** The Radix slider contract: values are always `number[]`, one per thumb. */
type SliderRootProps = Omit<React.ComponentProps<'div'>, 'defaultValue' | 'dir' | 'onChange'> & {
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
  /** Fires once when a drag or key press ends. */
  onValueCommit?: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  minStepsBetweenThumbs?: number;
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  /** Accepted for Radix parity; Base UI does not invert. */
  inverted?: boolean;
  dir?: 'ltr' | 'rtl';
  name?: string;
};

const asArray = (value: number | readonly number[]) =>
  (Array.isArray(value) ? [...value] : [value as number]) as number[];

type SliderProps = SliderRootProps & {
  /**
   * Accessible name for the thumb(s). Each thumb holds the `role="slider"`
   * input, so a name on the root is never announced — it has to land here.
   * Pass an array to name each thumb of a range slider.
   */
  thumbLabel?: string | string[];
  /** Announced in place of the raw number (`aria-valuetext`), e.g. `40%`, `0.85`. */
  formatValue?: (value: number, index: number) => string;
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueChange,
  thumbLabel,
  formatValue,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  onValueCommit,
  minStepsBetweenThumbs,
  inverted: _inverted,
  orientation,
  ...props
}: SliderProps) {
  const [uncontrolledValues, setUncontrolledValues] = React.useState<number[]>(() =>
    Array.isArray(defaultValue) ? defaultValue : [min, max],
  );
  const values = Array.isArray(value) ? value : uncontrolledValues;

  const handleValueChange = React.useCallback(
    (next: number[]) => {
      setUncontrolledValues(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const labelFor = (index: number) => {
    if (Array.isArray(thumbLabel)) return thumbLabel[index];
    const base = thumbLabel ?? ariaLabel;
    if (!base || values.length < 2) return base;
    if (index === 0) return `${base} minimum`;
    if (index === values.length - 1) return `${base} maximum`;
    return `${base} ${index + 1}`;
  };

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      data-orientation={orientation ?? 'horizontal'}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      orientation={orientation}
      minStepsBetweenValues={minStepsBetweenThumbs}
      onValueChange={(next) => handleValueChange(asArray(next))}
      onValueCommitted={onValueCommit ? (next) => onValueCommit(asArray(next)) : undefined}
      className={cn(
        'group/slider relative flex w-full cursor-pointer touch-none items-center select-none',
        'data-disabled:pointer-events-none data-disabled:cursor-default data-disabled:opacity-50', // cursor-default: disabled control.
        'data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
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
          className={cn(
            // Hairline rail: the whole control is one thin ink stroke.
            'bg-primary/10 relative grow overflow-hidden rounded-full',
            'data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full',
            'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1',
          )}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn(
              'bg-primary absolute rounded-full data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
            )}
          />
        </SliderPrimitive.Track>
        {values.map((_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            index={index}
            aria-label={labelFor(index)}
            aria-labelledby={ariaLabelledBy}
            getAriaValueText={
              formatValue ? (_formatted, thumbValue) => formatValue(thumbValue, index) : undefined
            }
            className={cn(
              // Caret thumb: a short vertical bar in the same ink as the fill, so
              // the range reads as one continuous stroke that rises into a handle.
              'bg-primary block h-4 w-2 shrink-0 rounded-full',
              'group-data-[orientation=vertical]/slider:h-1 group-data-[orientation=vertical]/slider:w-4',
              // 44x51px touch target without shifting layout.
              'hit-area-x-4 hit-area-y-5 cursor-pointer',
              // `scale` composes with the thumb's inline `translate: -50% -50%` (Tailwind v4
              // uses the standalone `scale` property), so the bar grows around its
              // own center without breaking thumb positioning.
              'duration-fast ease-default transition-[scale,box-shadow] outline-none',
              'active:scale-x-150 active:scale-y-125',
              // Focus: accent ring with a surface-coloured gap that punches through
              // the track, so the indicator reads as "on the thumb".
              // `:focus-within` — the thumb's focusable node is its hidden range input.
              // Not `:focus-visible`: Chrome resolves focus-visible once, at
              // focus time, so a thumb grabbed by pointer would stay unringed for the
              // rest of the interaction even after the user switches to arrow keys.
              'focus-within:ring-ring focus-within:ring-offset-background focus-within:ring-2 focus-within:ring-offset-2',
              // Forced-colors mode strips box-shadow rings; a transparent outline is
              // repainted there as a real system-coloured focus ring.
              'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-transparent focus-within:outline-solid',
              'data-disabled:pointer-events-none data-disabled:cursor-default', // cursor-default: disabled control.
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
export type { SliderProps, SliderRootProps };
