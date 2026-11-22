'use client';

import { useState, type CSSProperties } from 'react';

import { COLOR_DOT, COLOR_DOT_RAINBOW, CustomColor } from './glyph-picker';
import { cn } from '../lib/utils';

/**
 * A colour picker panel with the same shape as the project icon picker's
 * colour row (`glyph-picker.tsx`): a row of preset dots, a divider, and a
 * rainbow dot that swaps the row for the custom field. The selected dot
 * carries a ring in its own colour; no glyph is drawn on it (HEX, a
 * saturation/value square, a hue rail). Built for a `PopoverContent`.
 *
 * `value` and every preset are `#rrggbb`. A pick never closes the panel, so
 * the result can be judged live; clicking outside closes it.
 */
export function ColorPickerPanel({
  value,
  presets,
  onChange,
  customLabel,
  presetLabel,
}: {
  value: string;
  presets: readonly string[];
  onChange: (color: string) => void;
  /** Accessible name of the rainbow dot. */
  customLabel: string;
  /** Accessible name of a preset dot, given its hex value. */
  presetLabel: (color: string) => string;
}) {
  const current = value.toLowerCase();
  const isPreset = presets.some((preset) => preset.toLowerCase() === current);
  const [customOpen, setCustomOpen] = useState(!isPreset);

  if (customOpen) {
    return <CustomColor color={current} onChange={onChange} onClose={() => setCustomOpen(false)} />;
  }

  return (
    <div className="flex h-12 items-center justify-between gap-2 px-4">
      {presets.map((preset) => {
        const selected = preset.toLowerCase() === current;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={selected}
            aria-label={presetLabel(preset)}
            onClick={() => onChange(preset.toLowerCase())}
            style={{ background: preset, '--glyph': preset } as CSSProperties}
            className={cn(
              COLOR_DOT,
              selected && 'ring-offset-popover ring-[1.5px] ring-[color:var(--glyph)] ring-offset-2',
            )}
          />
        );
      })}
      <span aria-hidden className="bg-border h-5 w-px shrink-0" />
      <button
        type="button"
        aria-pressed={!isPreset}
        aria-label={customLabel}
        onClick={() => setCustomOpen(true)}
        className={cn(
          COLOR_DOT,
          COLOR_DOT_RAINBOW,
          !isPreset && 'ring-foreground ring-offset-popover ring-[1.5px] ring-offset-2',
        )}
      />
    </div>
  );
}
