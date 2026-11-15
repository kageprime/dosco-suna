/**
 * Moving artifacts between sandboxes: read them from the agent's sandbox,
 * re-create them in a separate verifier's. The rules (what is collected, how
 * it is sanitized, where it lands) are `artifacts.ts`.
 */
import type { HarborTask } from './harbor-task';
import { makeBoxDir, readBoxFile, statBoxTree, writeBoxFile, writeBoxSymlink, type Box } from './box';
import {
  ARTIFACT_BYTES_MAX,
  ARTIFACT_FILES_MAX,
  ARTIFACTS_CONVENTION,
  artifactEntries,
  sanitizedFileMode,
  sanitizeTree,
  sourcePath,
  type CollectedArtifact,
  type SanitizedTree,
} from './artifacts';

/** Read every artifact of a trial from the agent's sandbox, within the trial's limits. */
export async function readArtifacts(box: Box, task: Pick<HarborTask, 'artifacts' | 'workdir'>): Promise<CollectedArtifact[]> {
  const collected: CollectedArtifact[] = [];
  let files = 0;
  let bytes = 0;
  for (const artifact of artifactEntries(task)) {
    const path = sourcePath(artifact.source, task.workdir);
    const base: CollectedArtifact = { artifact, path, type: 'directory', status: 'ok', files: [], dirs: [], symlinks: [], skipped: [], error: null };
    try {
      const node = await statBoxTree(box, path, ARTIFACT_FILES_MAX);
      if (node.kind === 'missing') {
        // The publish folder may stay empty; a declared path the agent never wrote is a failed collection.
        collected.push({ ...base, status: path === ARTIFACTS_CONVENTION ? 'empty' : 'failed', error: path === ARTIFACTS_CONVENTION ? null : 'not found' });
        continue;
      }
      if (node.kind === 'symlink' || node.kind === 'other') {
        collected.push({ ...base, type: 'file', status: 'skipped', skipped: [{ path: '', reason: node.kind === 'symlink' ? 'the artifact is a symlink' : 'special file' }] });
        continue;
      }
      const tree: SanitizedTree =
        node.kind === 'file' ? { files: [{ path: '', mode: sanitizedFileMode(node.mode), size: node.size }], dirs: [], symlinks: [], skipped: [] } : sanitizeTree(node.entries, artifact.exclude);
      const size = tree.files.reduce((sum, file) => sum + file.size, 0);
      if ((node.kind === 'dir' && node.truncated) || files + tree.files.length > ARTIFACT_FILES_MAX || bytes + size > ARTIFACT_BYTES_MAX) {
        collected.push({ ...base, type: node.kind === 'file' ? 'file' : 'directory', status: 'failed', error: `more than ${ARTIFACT_FILES_MAX} files or ${ARTIFACT_BYTES_MAX / 1024 / 1024} MB of artifacts in this trial` });
        continue;
      }
      const read: CollectedArtifact['files'] = [];
      for (const file of tree.files) {
        const content = await readBoxFile(box, file.path ? `${path}/${file.path}` : path, file.size);
        if (content) read.push({ path: file.path, mode: file.mode, bytes: content });
      }
      files += read.length;
      bytes += size;
      const empty = read.length === 0 && tree.symlinks.length === 0 && tree.dirs.length === 0;
      collected.push({ ...base, type: node.kind === 'file' ? 'file' : 'directory', status: empty ? 'empty' : 'ok', files: read, dirs: tree.dirs, symlinks: tree.symlinks, skipped: tree.skipped });
    } catch (err) {
      collected.push({ ...base, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return collected;
}

/** Re-create collected artifacts in a separate verifier's sandbox, at their source paths. */
export async function restoreArtifacts(box: Box, collected: readonly CollectedArtifact[]): Promise<void> {
  for (const entry of collected) {
    if (entry.status !== 'ok' && entry.status !== 'empty') continue;
    if (entry.type === 'file') {
      for (const file of entry.files) await writeBoxFile(box, entry.path, file.bytes, file.mode);
      continue;
    }
    await makeBoxDir(box, entry.path);
    for (const dir of entry.dirs) await makeBoxDir(box, `${entry.path}/${dir}`);
    for (const file of entry.files) await writeBoxFile(box, `${entry.path}/${file.path}`, file.bytes, file.mode);
    for (const link of entry.symlinks) await writeBoxSymlink(box, `${entry.path}/${link.path}`, link.target);
  }
}
