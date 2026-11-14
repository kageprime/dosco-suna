/**
 * Which surface a subtree is drawn on, so a `SettingsGroup` picks a row fill
 * that stands apart from it (Jay, 2026-09-23).
 *
 * `KortixBottomSheetModal` provides `'sheet'`, or `'glass'` in the iOS 26
 * native sheet, whose background is the system Liquid Glass. Everything else
 * is `'page'`.
 */
import * as React from 'react';

export type Surface = 'page' | 'sheet' | 'glass';

export const SurfaceContext = React.createContext<Surface>('page');

/**
 * Row fill of a `SettingsGroup` on a sheet (or a dialog, the same `popover`
 * colour). The page default, `bg-card`, IS the sheet colour in dark mode
 * (both 7.8%), so rows vanished there. Light: `secondary` 92.6% on the white
 * sheet. Dark: `background` 4.3% under the 7.8% sheet, a darker well.
 */
export const SHEET_ROW_SURFACE = 'bg-secondary dark:bg-background';

/**
 * Row fill on the iOS 26 glass sheet: a translucent ink layer, not a solid
 * colour. The glass changes tone with what is behind it, so a solid
 * `secondary` read almost the same as the glass in one place and different
 * in the next: the model rows and the Thinking track showed as uneven grey
 * patches (Jay, 2026-11-12). A translucent fill keeps the same contrast to
 * the glass under every row.
 */
export const GLASS_ROW_SURFACE = 'bg-foreground/[0.06] dark:bg-foreground/10';

/** The row fill of a `SettingsGroup` on `surface`. */
export function rowSurface(surface: Surface): string {
  if (surface === 'glass') return GLASS_ROW_SURFACE;
  return surface === 'sheet' ? SHEET_ROW_SURFACE : 'bg-card';
}

/**
 * The fill of a control that sits on a sheet (a tile, a slider track):
 * `bg-secondary`, or the glass fill in the iOS 26 native sheet.
 */
export function useControlFill(): string {
  return React.useContext(SurfaceContext) === 'glass' ? GLASS_ROW_SURFACE : 'bg-secondary';
}
