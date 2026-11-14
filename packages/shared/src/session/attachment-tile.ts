/**
 * The pure rules of an attachment tile. Both hosts
 * (`packages/ui/src/session/composer/attachment-tile.tsx`,
 * `apps/mobile/lib/session/attachment-tile.ts`) re-export these, so every
 * fix lands once.
 */

/** What the tile prints in the file's corner. Lowercase, from the name first
 *  and the MIME subtype second; empty when neither says anything. */
export function attachmentExtension(filename: string, mime?: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).trim().toLowerCase();
    if (ext.length > 0 && ext.length <= 8 && !/\s/.test(ext)) return ext;
  }
  const subtype = (mime ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!subtype) return '';
  // `svg+xml` → `svg`, `x-icon` → `icon`, `vnd.ms-excel` → `ms-excel`.
  return subtype.split('+')[0]!.replace(/^x-/, '').split('.').pop() ?? '';
}

/**
 * Which files the tile shows AS A PICTURE. Raster images only. An SVG is text
 * that happens to draw — a logo file on a tile is a black blob at 100px, and
 * its name is what tells it from the next logo file (Jay, 2026-09-06). It
 * gets the named treatment, badge and all.
 */
export function isPreviewableImage(filename: string, mime?: string): boolean {
  if (attachmentExtension(filename, mime) === 'svg') return false;
  return (mime ?? '').toLowerCase().startsWith('image/');
}

/**
 * How a name is laid out on the tile.
 *
 * A short name wraps over two lines as the browser sees fit. A long one is
 * split: the first line is the head, ellipsized by CSS at the tile's edge, and
 * the second line is the last ten characters verbatim — the part that carries
 * the extension and tells `…-chatux.md` from `…-ux.md`. A single middle
 * ellipsis in one string wrapped wherever the browser chose, and left a
 * dangling hyphen at the end of line one (2026-09-06).
 */
export const LONG_NAME_THRESHOLD = 24;
export const NAME_TAIL_CHARS = 10;

export function splitFilenameForTile(name: string): { head: string; tail: string } | null {
  if (name.length <= LONG_NAME_THRESHOLD) return null;
  return { head: name.slice(0, -NAME_TAIL_CHARS), tail: name.slice(-NAME_TAIL_CHARS) };
}

/**
 * A short name cut into the pieces a line may break between: after `-`, `_`
 * or a space, and before the extension's dot. The tile puts a `<wbr>` between
 * pieces and lets the browser break nowhere else unless one piece alone is
 * wider than the tile, so `dsa-c-attach.txt` wraps as `dsa-c-attach` /
 * `.txt`, never `dsa-c-attach.t` / `xt` (dev audit, 2026-11-14).
 */
export function filenameBreakSegments(name: string): string[] {
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const segments = stem.split(/(?<=[-_ ])/).filter(Boolean);
  if (hasExtension) segments.push(name.slice(dot));
  return segments.length ? segments : [name];
}
