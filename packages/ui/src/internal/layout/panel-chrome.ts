/**
 * The session screen's docked chrome — ONE definition for every bar and layer.
 *
 * The session screen is one frame split by hairlines: the chat on the left, the
 * cards column and the detail panel (browser, terminal, files, a file preview)
 * on the right. Nothing on it floats. Every top bar is the same height and
 * draws the same bottom rule, so the rules line up into one horizontal line
 * across every column, and every column is separated by one vertical rule.
 *
 * Before this file each surface picked its own bar (`py-1`, `py-2.5`, `h-10`)
 * and the detail panel was a card inset by 12px with `shadow-md`. The brand
 * rule is that an in-flow surface is flat: border, no shadow (`effects.md`).
 * Import these instead of restating them, or the bars drift apart again.
 */

/**
 * A top bar: the chat's session header, the detail panel's header, the
 * browser's address bar, the file preview's header, the terminal's header.
 * Callers add horizontal padding, gap and justification. `h-11` is 40.48px
 * (`--spacing` is 0.23rem): a `size-7` control (25.76px) plus 7.36px above
 * and below.
 */
export const SESSION_BAR_CLASS = 'border-border flex h-11 shrink-0 items-center border-b';

/**
 * A detail layer docked in the right panel: it fills the panel edge to edge.
 * The panel draws the vertical rule (`border-l`), so the layer draws none.
 */
export const DOCKED_LAYER_CLASS =
  'bg-background absolute inset-0 flex min-w-0 flex-col overflow-hidden';
