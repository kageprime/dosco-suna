/** Clip one line to `width` columns, with an ellipsis when it was clipped. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(width - 1, 0))}…`;
}
