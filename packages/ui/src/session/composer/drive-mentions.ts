import type { JSONContent } from '@tiptap/core';

import type { DriveUploadLike } from '../../internal/lib/project-preamble';
import type { AttachedFile } from './types';

/**
 * Drive `@` mentions in the composer. A Drive chip (`kind: 'drive'`, `value`
 * its Drive path) names a file; the bytes ride as an ordinary attachment the
 * composer staged when the file was picked, marked with the same path
 * (`AttachedFile.drivePath`).
 */

const isDriveChip = (node: JSONContent) => node.type === 'mention' && node.attrs?.kind === 'drive';

/** The document's Drive chips: Drive path → the file's name, first chip of a path wins. */
export function driveChipsIn(doc: JSONContent | null | undefined): Map<string, string> {
  const chips = new Map<string, string>();
  const walk = (node: JSONContent) => {
    const path = node.attrs?.value;
    if (isDriveChip(node) && typeof path === 'string' && path && !chips.has(path)) chips.set(path, String(node.attrs?.label ?? ''));
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return chips;
}

/** The Drive paths the document's chips name. */
export function drivePathsIn(doc: JSONContent | null | undefined): Set<string> {
  return new Set(driveChipsIn(doc).keys());
}

/** The document without the chips that name `path` (a file that could not be attached). */
export function withoutDriveChips(doc: JSONContent, path: string): JSONContent {
  const prune = (node: JSONContent): JSONContent =>
    node.content
      ? { ...node, content: node.content.filter((child) => !(isDriveChip(child) && child.attrs?.value === path)).map(prune) }
      : node;
  return prune(doc);
}

/**
 * The upload name for a picked Drive file: its own name, unless the tray
 * already holds that name, then the name with its folder (`logo (brand).png`),
 * so the agent tells two `logo.png` apart.
 */
export function driveUploadName(name: string, path: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const folder = path.split('/').slice(-2, -1)[0] || 'Drive';
  let candidate = `${stem} (${folder})${ext}`;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${stem} (${folder} ${n})${ext}`;
  return candidate;
}

/** The tray's files that came from Drive, as the reference blocks read them. */
export function driveUploadsOf(files: readonly AttachedFile[] | undefined): DriveUploadLike[] {
  return (files ?? []).flatMap((file) =>
    file.kind !== 'remote' && file.drivePath
      ? [{ name: file.kind === 'local' ? file.file.name : file.filename, drivePath: file.drivePath }]
      : [],
  );
}

/** Keeps the tray's Drive files in step with the document's Drive chips (`createDriveChipSync`). */
export type DriveChipSync = {
  /** A path picked from the menu: a chip of it that comes back without its file fetches the file again. */
  trust: (path: string) => void;
  /** Every document change. `recalling`: a recalled prompt replaces the draft for a moment and the tray keeps its files. */
  onDoc: (doc: JSONContent, recalling: boolean) => void;
};

export function createDriveChipSync(deps: {
  tray: () => readonly AttachedFile[];
  remove: (index: number) => void;
  refetch: (file: { path: string; name: string }) => void;
  /** A question lock keeps the tray. */
  paused: () => boolean;
}): DriveChipSync {
  const { tray, remove, refetch, paused } = deps;
  /** The Drive paths the document named after its last change: a path that leaves it is a deleted chip. */
  let named = new Set<string>();
  /**
   * The only chips worth fetching a file for again: picked from the menu here, or one whose Drive file the
   * tray held (a restored draft or failed send). A chip that arrives any other way (pasted rich text) is
   * never a request to read a file.
   */
  const trusted = new Set<string>();
  const held = (path: string) => tray().findIndex((file) => file.kind !== 'remote' && file.drivePath === path);
  return {
    trust: (path) => void trusted.add(path),
    onDoc(doc, recalling) {
      const chips = driveChipsIn(doc);
      const previous = named;
      named = new Set(chips.keys());
      if (recalling) return;
      const removed = [...previous].filter((path) => !chips.has(path));
      const added = [...chips].filter(([path]) => !previous.has(path));
      if (removed.length === 0 && added.length === 0) return;
      // Run after the change settles. A send or a command empties the editor and hands its tray off in
      // the same handler, and a restore (draft, failed send, prefill) sets the document and then its
      // files: by then the tray is what the change left.
      queueMicrotask(() => {
        if (paused()) return;
        // The person deleted the last chip of a path: its file leaves the tray, and an undo may fetch it back.
        for (const path of removed) {
          const index = held(path);
          if (index === -1) continue;
          trusted.add(path);
          remove(index);
        }
        // A trusted chip came back without its file (an undo, a redo): fetch it again.
        for (const [path, name] of added) if (trusted.has(path) && held(path) === -1) refetch({ path, name });
      });
    },
  };
}
