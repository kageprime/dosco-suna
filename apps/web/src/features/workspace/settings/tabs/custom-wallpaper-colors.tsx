'use client';

/**
 * The colour, finish and opacity control of the Custom wallpaper and of
 * every gradient preset. A popover with the
 * ready-made palettes and the current swatches; each swatch opens the colour
 * picker (presets and a custom HEX field), and − / + drop or add a colour.
 * Every pick writes the preference at once, so the page and the card update
 * while the popover stays open.
 */

import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { ColorPickerPanel } from '@kortix/ui/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { Slider } from '@kortix/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import {
  CUSTOM_COLOR_PRESETS,
  CUSTOM_PALETTES,
  GRADIENT_FINISHES,
  GRADIENT_MAX_COLORS,
  GRADIENT_MIN_COLORS,
  OPACITY_LIMITS,
  nextCustomColor,
  type GradientFinish,
} from '@kortix/ui/theme';

export interface CustomWallpaperCopy {
  editColors: string;
  shuffle: string;
  palette: string;
  paletteLabel: (count: number) => string;
  colors: string;
  colorLabel: (count: number) => string;
  customColor: string;
  addColor: string;
  removeColor: string;
  resetColors: string;
  finish: string;
  finishes: Record<GradientFinish, string>;
  opacity: string;
}

/** A palette as one horizontal strip, a segment per colour. */
function PaletteStrip({ colors }: { colors: readonly string[] }) {
  return (
    <span aria-hidden className="flex h-full w-full overflow-hidden rounded-sm">
      {colors.map((color, index) => (
        // Index keys: a palette may repeat a colour.
        <span key={index} className="h-full flex-1" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

export function CustomWallpaperColors({
  colors,
  onChange,
  finish,
  onFinishChange,
  opacity,
  onOpacityChange,
  copy,
  onReset,
  children,
}: {
  colors: string[];
  onChange: (colors: string[]) => void;
  finish: GradientFinish;
  onFinishChange: (finish: GradientFinish) => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  copy: CustomWallpaperCopy;
  /** Restores a recoloured preset's own colours. Omitted when there is nothing to restore. */
  onReset?: () => void;
  /** The trigger: a button over the Custom card. */
  children: ReactNode;
}) {
  const current = colors.join().toLowerCase();

  return (
    <Popover modal>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        // Beside the card, not over it: the wallpaper being recoloured stays visible.
        side="right"
        align="start"
        sideOffset={8}
        aria-label={copy.editColors}
        className="w-72 space-y-3 p-3"
      >
        <div className="space-y-1.5">
          <span className="text-muted-foreground text-xs">{copy.palette}</span>
          <div className="grid grid-cols-3 gap-1.5">
            {CUSTOM_PALETTES.map((palette, index) => {
              const selected = palette.join().toLowerCase() === current;
              return (
                <button
                  key={palette.join()}
                  type="button"
                  aria-pressed={selected}
                  aria-label={copy.paletteLabel(index + 1)}
                  onClick={() => onChange([...palette])}
                  className={cn(
                    'duration-fast focus-visible:ring-kortix-blue flex h-7 cursor-pointer rounded-md p-1 transition-colors focus-visible:ring-1 focus-visible:outline-none',
                    selected ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.05]',
                  )}
                >
                  <PaletteStrip colors={palette} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-muted-foreground text-xs">{copy.colors}</span>
          <div className="flex items-center gap-1.5">
            {colors.map((color, index) => (
              // Index keys: a swatch has no identity but its position.
              <Popover key={index} modal>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={copy.colorLabel(index + 1)}
                    data-color-swatch={color}
                    className="border-border focus-visible:ring-kortix-blue duration-fast size-7 cursor-pointer rounded-full border transition-[scale] focus-visible:ring-1 focus-visible:outline-none active:scale-[0.96]"
                    style={{ backgroundColor: color }}
                  />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  aria-label={copy.colorLabel(index + 1)}
                  // 9 dots of 6 + 9 gaps of 2 + 2·4 padding + the 1px
                  // divider = 80 spacing units; +2px is the border.
                  className="w-[calc(80*var(--spacing)+3px)] overflow-hidden p-0"
                >
                  <ColorPickerPanel
                    value={color}
                    presets={CUSTOM_COLOR_PRESETS}
                    onChange={(next) => onChange(colors.map((c, i) => (i === index ? next : c)))}
                    customLabel={copy.customColor}
                    presetLabel={(hex) => `${copy.colorLabel(index + 1)}: ${hex}`}
                  />
                </PopoverContent>
              </Popover>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.removeColor}
              disabled={colors.length <= GRADIENT_MIN_COLORS}
              onClick={() => onChange(colors.slice(0, -1))}
            >
              <MinusIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={copy.addColor}
              disabled={colors.length >= GRADIENT_MAX_COLORS}
              onClick={() => onChange([...colors, nextCustomColor(colors)])}
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-muted-foreground text-xs">{copy.finish}</span>
          <Tabs value={finish} onValueChange={(next) => onFinishChange(next as GradientFinish)}>
            <TabsList aria-label={copy.finish} className="w-full">
              {GRADIENT_FINISHES.map((option) => (
                <TabsTrigger key={option} value={option}>
                  {copy.finishes[option]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{copy.opacity}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {Math.round(opacity * 100)}%
            </span>
          </div>
          <Slider
            min={OPACITY_LIMITS[0]}
            max={OPACITY_LIMITS[1]}
            step={0.05}
            value={[opacity]}
            thumbLabel={copy.opacity}
            formatValue={(value) => `${Math.round(value * 100)}%`}
            onValueChange={(next) => onOpacityChange(next[0]!)}
          />
        </div>

        {onReset ? (
          <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onReset}>
            <ArrowCounterClockwiseIcon className="size-3.5" />
            {copy.resetColors}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
