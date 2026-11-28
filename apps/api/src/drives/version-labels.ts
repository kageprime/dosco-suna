// How a drive version reads in the versions list: storage's commit kind and
// author, block or shared volume, in the four kinds and three authors the
// apps show.
import type { VolumeCommit } from './volumes';

export type DriveVersionKind = 'created' | 'edit' | 'sync' | 'restore';
export type DriveVersionAuthor = 'drive' | 'session' | 'system';

/**
 * A version's kind from storage's commit kind. A block volume's: `init`,
 * `fork`, `restore`, `api`, `import`, `merge`, `fast`, ... A shared volume
 * versions itself after its writes settle: `api` (a write through Files),
 * `sync` (sessions' work in a mounted folder), `auto` (storage's own, e.g.
 * before a restore), `restore`, `tag`. Any kind not known here reads as a sync.
 */
export function versionKind(kind: unknown): DriveVersionKind {
  if (kind === 'init' || kind === 'fork') return 'created';
  if (kind === 'restore') return 'restore';
  if (kind === 'api' || kind === 'import') return 'edit';
  return 'sync';
}

/** Who made a version: a session (`sandbox`, a merge), the drive (a person through Files), or Kortix/storage itself (`auto`, anything else). */
export function versionAuthor(commit: Pick<VolumeCommit, 'kind' | 'author'>): DriveVersionAuthor {
  const author = typeof commit.author?.kind === 'string' ? commit.author.kind : undefined;
  if (commit.kind === 'auto') return 'system';
  if (author === 'sandbox' || commit.kind === 'merge' || commit.kind === 'fast') return 'session';
  if (author === 'api_key' || author === 'user') return 'drive';
  // A shared volume's version with no author: its kind says who.
  if (author === undefined && commit.kind === 'sync') return 'session';
  if (author === undefined && commit.kind === 'api') return 'drive';
  return 'system';
}
