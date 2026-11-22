/**
 * Loopmaxxing's own palette: the four colors of the hula hoop it is named
 * after (founder call 2026-11-18). This page is a deliberate exception to the
 * one-accent rule of the Kortix brand kit, and these values exist on this
 * page only. They paint the dither fields, where each pixel is drawn at 85%
 * over black, so every color is set one step brighter than the toy: the
 * yellow especially, which turns brown when it is darkened.
 */
export const HOOP_PALETTE = [
  '#FF4747', // audit:allow Loopmaxxing hoop palette (red), founder call 2026-11-18
  '#3F6FFF', // audit:allow Loopmaxxing hoop palette (blue), founder call 2026-11-18
  '#3FD95C', // audit:allow Loopmaxxing hoop palette (green), founder call 2026-11-18
  '#FFDA3D', // audit:allow Loopmaxxing hoop palette (yellow), founder call 2026-11-18
] as const;

/**
 * The hoop's segments as the toy has them: long and short pieces, never one
 * color twice in a row. `color` indexes the palette; lengths are percent.
 */
export const SEGMENTS: ReadonlyArray<{ color: number; length: number }> = [
  { color: 3, length: 7 },
  { color: 2, length: 16 },
  { color: 1, length: 15 },
  { color: 0, length: 12 },
  { color: 2, length: 9 },
  { color: 0, length: 14 },
  { color: 1, length: 17 },
  { color: 0, length: 10 },
];

/** Where each segment starts on the ring, in percent. */
export const STARTS = SEGMENTS.map((_, index) => SEGMENTS.slice(0, index).reduce((sum, segment) => sum + segment.length, 0));

/** The palette index of the segment at a point of the ring, `fraction` of the way round (0 to 1). */
export function hoopColorAt(fraction: number): number {
  const percent = (((fraction % 1) + 1) % 1) * 100;
  for (let index = SEGMENTS.length - 1; index >= 0; index -= 1) {
    if (percent >= STARTS[index]!) return SEGMENTS[index]!.color;
  }
  return SEGMENTS[0]!.color;
}
