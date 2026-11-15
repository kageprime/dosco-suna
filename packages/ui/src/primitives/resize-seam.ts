import { cn } from '../lib/utils';

/**
 * The resize seam: one plain 1px line in the ring blue (`--ring`) on a drag
 * edge, drawn exactly over the hairline it replaces. No taper, no fade: a
 * docked edge is a straight rule, and the seam is that rule lit. Drawn by
 * `before:`, so a caller keeps `after:` for its hit strip. Hidden at rest; the
 * caller reveals it (`before:opacity-100`) on hover, focus and drag. Opacity
 * only: a width or position transition would animate layout on hover.
 *
 * The sidebar rail (`sidebar-panel.tsx`) and every `ResizableHandle` draw it,
 * so every drag-to-resize edge in the app looks the same.
 */
export const RESIZE_SEAM_CLASS = cn(
  'before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:z-10 before:w-px before:-translate-x-1/2 before:opacity-0',
  'before:bg-ring before:transition-opacity before:duration-fast before:ease-out',
  'motion-reduce:before:transition-none',
);
