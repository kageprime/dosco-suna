/**
 * Attachment tile logic — a port of the pure parts of apps/web
 * `features/session/attachment-tile.tsx` and `planAttachmentGrid` in
 * `features/session/turn/user-message.tsx`. `components/session/attachment-tile.tsx`
 * owns how a tile looks. The five tile rules live once in
 * `@kortix/shared/session/attachment-tile`.
 */

export {
  LONG_NAME_THRESHOLD,
  NAME_TAIL_CHARS,
  attachmentExtension,
  isPreviewableImage,
  splitFilenameForTile,
} from '@kortix/shared/session/attachment-tile';

/** Tiles in a sent message before the strip collapses into a `+N` tile. */
export const ATTACHMENT_TILE_CAP = 8;

export interface AttachmentGridPlan<T> {
  visible: T[];
  /** Attachments behind the `+N` tile; 0 when there is no overflow tile. */
  overflowCount: number;
}

/**
 * Past the cap, `cap - 1` tiles show and the last slot is the `+N` tile, so
 * the strip is never more than `cap` tiles. `overflowCount` counts every
 * attachment not drawn. (apps/web reports `length - cap`, one fewer than it
 * hides, because its `+N` tile covers the 8th attachment.)
 */
export function planAttachmentGrid<T>(items: readonly T[], expanded: boolean): AttachmentGridPlan<T> {
  if (expanded || items.length <= ATTACHMENT_TILE_CAP) {
    return { visible: [...items], overflowCount: 0 };
  }
  const shown = ATTACHMENT_TILE_CAP - 1;
  return { visible: items.slice(0, shown), overflowCount: items.length - shown };
}

/**
 * Where a message attachment's bytes come from. `data:` and `http(s):` URLs
 * load directly; a `file://` URL or a bare path is a file in the session
 * sandbox and loads through `useSandboxImage` (HEAD probe + tap-to-load limit).
 */
export function resolveAttachmentSource(
  src: string | undefined,
): { uri: string } | { path: string } | null {
  if (!src) return null;
  if (/^(data|https?):/i.test(src)) return { uri: src };
  if (/^file:\/\//i.test(src)) return { path: src.replace(/^file:\/\//i, '') };
  return { path: src };
}

/**
 * A composer tile's source: `localUri` (the picker's own `file://` URI) loads
 * directly, bypassing `resolveAttachmentSource` — which maps a `file://` URL
 * to a **sandbox** path, wrong for a file that never left the device. Once a
 * message is sent and only `src` (the server attachment reference) remains,
 * sandbox resolution applies as before.
 */
export function localOrResolvedSource(
  localUri: string | undefined,
  src: string | undefined,
): { uri: string } | { path: string } | null {
  if (localUri) return { uri: localUri };
  return resolveAttachmentSource(src);
}
