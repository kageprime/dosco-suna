/**
 * SheetTextInput — the one canonical text field for bottom sheets. Fully-rounded
 * pill, standard input border/background, Roobert font. Wraps `SheetRawTextInput`
 * (`sheet-parts.tsx`): gorhom's `BottomSheetTextInput` in a gorhom sheet, so the
 * keyboard lifts the sheet, and React Native's `TextInput` in a native sheet.
 *
 * The pill's look comes from `usePillInputStyle` (./pill-input), shared with
 * `PillInput`, the same field for full screens outside a sheet.
 *
 * Pass `mono` for slug-style values, or override anything via `style`.
 */

import React from 'react';
import { SheetRawTextInput } from './sheet-parts';

import { usePillInputStyle } from './pill-input';

type BottomSheetTextInputProps = React.ComponentProps<typeof SheetRawTextInput>;

/** The sheet field's established height. */
const SHEET_INPUT_HEIGHT = 48;

interface SheetTextInputProps extends BottomSheetTextInputProps {
  /** Use a monospace font (for slugs / identifiers). */
  mono?: boolean;
}

export function SheetTextInput({ mono, style, placeholderTextColor, ...props }: SheetTextInputProps) {
  // SheetRawTextInput isn't imported from 'react-native' directly, so
  // NativeWind never patches it with className support the way `<Input>`
  // gets it — the pill style is applied inline from THEME instead.
  const pill = usePillInputStyle({ height: SHEET_INPUT_HEIGHT, mono });
  return (
    <SheetRawTextInput
      placeholderTextColor={placeholderTextColor ?? pill.placeholderTextColor}
      {...props}
      style={[pill.style, style]}
    />
  );
}
