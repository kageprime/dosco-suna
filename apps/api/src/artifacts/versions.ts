// Which Files commits are versions of an artifact. Pure: service.ts reads the
// commits and the entry file's stat at each one.

/** The entry file as one commit has it; null when the file is not in that commit. */
export interface EntryAtCommit<C> {
  commit: C;
  stat: { size: number; mtime: number } | null;
}

/**
 * The commits that saved the entry file, oldest first. A save changes the
 * file's bytes or its write time. Storage's `version` also changes on an
 * owner or mode change: every box that mounts the folder hands a root-owned
 * file to its runtime user a few seconds after the API writes it
 * (apps/sandbox/entrypoint.sh, the drive-owner helper). That commit is not a
 * save, so this compares size and mtime, never `version`.
 */
export function entrySaves<C>(oldestFirst: readonly EntryAtCommit<C>[]): C[] {
  const saves: C[] = [];
  let previous: string | null = null;
  for (const { commit, stat } of oldestFirst) {
    if (!stat) continue;
    const key = `${stat.size}:${stat.mtime}`;
    if (key !== previous) saves.push(commit);
    previous = key;
  }
  return saves;
}
