/**
 * Harbor artifacts (https://harborframework.com/docs/tasks/artifacts): sandbox
 * paths collected after the agent phase.
 *
 * - The trial folder keeps them under `artifacts/`: an entry with a
 *   `destination` lands there, any other mirrors its source path
 *   (`/app/report.json` → `artifacts/app/report.json`). `/logs/artifacts/`,
 *   the agent's publish folder, is always collected. `artifacts/manifest.json`
 *   records every entry.
 * - A separate verifier gets them at their source paths, sanitized as
 *   Python's tarfile `data` filter does: no setuid, setgid or sticky bit, no
 *   group or other write bit, no device, pipe or socket, no symlink that is
 *   absolute or points outside the artifact.
 */
import { posix } from 'node:path';
import type { HarborArtifact, HarborTask } from './harbor-task';
import type { BoxTreeEntry } from './box';
import type { StoredFile } from './storage';

/** The agent's publish folder, collected without being declared. */
export const ARTIFACTS_CONVENTION = '/logs/artifacts';
/** What one trial collects, across its artifacts. */
export const ARTIFACT_FILES_MAX = 500;
export const ARTIFACT_BYTES_MAX = 20 * 1024 * 1024;

/** The task's entries with the convention entry first, unless the task declares that folder itself. */
export function artifactEntries(task: Pick<HarborTask, 'artifacts'>): HarborArtifact[] {
  const declared = task.artifacts.some((entry) => entry.source.replace(/\/+$/, '') === ARTIFACTS_CONVENTION);
  return declared ? [...task.artifacts] : [{ source: ARTIFACTS_CONVENTION, destination: null, exclude: [] }, ...task.artifacts];
}

/** The absolute sandbox path of a source: a relative one is below the task's working directory. */
export function sourcePath(source: string, workdir: string | null): string {
  const absolute = source.startsWith('/') ? source : posix.join(workdir ?? '/', source);
  return posix.normalize(absolute).replace(/(.)\/+$/, '$1');
}

/** Where an entry lands below the trial's `artifacts/`: its destination, else its source path without the root. */
export function hostDestination(artifact: HarborArtifact, path: string): string {
  if (artifact.destination) return artifact.destination;
  return path.replace(/^\/+/, '') || '.';
}

/** fnmatch as GNU tar's `--exclude` uses it: `*` and `?` match `/` too. */
function fnmatch(pattern: string, name: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        source += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's').test(name);
}

/**
 * True when tar `--exclude` patterns drop `path` (relative to the artifact):
 * unanchored, so a pattern matches the whole path or any part of it after a
 * `/`; an excluded folder drops everything below it.
 */
export function tarExcluded(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const parts = path.split('/').filter(Boolean);
  for (let end = 1; end <= parts.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      const name = parts.slice(start, end).join('/');
      if (patterns.some((pattern) => fnmatch(pattern.replace(/\/+$/, ''), name))) return true;
    }
  }
  return false;
}

/** A regular file's mode after Python's `data` filter. */
export function sanitizedFileMode(mode: number): number {
  // No setuid, setgid, sticky; no group or other write; the owner may read and write.
  let next = (mode & 0o777 & ~0o022) | 0o600;
  // No group or other execute when the owner has none.
  if (!(next & 0o100)) next &= ~0o011;
  return next;
}

export interface SanitizedTree {
  files: Array<{ path: string; mode: number; size: number }>;
  dirs: string[];
  symlinks: Array<{ path: string; target: string }>;
  /** Entries the sanitizer refused, with why. */
  skipped: Array<{ path: string; reason: string }>;
}

/** The entries of a directory artifact that may be collected and restored. */
export function sanitizeTree(entries: readonly BoxTreeEntry[], exclude: readonly string[]): SanitizedTree {
  const out: SanitizedTree = { files: [], dirs: [], symlinks: [], skipped: [] };
  for (const entry of entries) {
    if (!entry.path || entry.path.split('/').includes('..') || tarExcluded(entry.path, exclude)) continue;
    if (entry.type === 'f') out.files.push({ path: entry.path, mode: sanitizedFileMode(entry.mode), size: entry.size });
    else if (entry.type === 'd') out.dirs.push(entry.path);
    else if (entry.type === 'l') {
      if (entry.target.startsWith('/')) {
        out.skipped.push({ path: entry.path, reason: 'absolute symlink' });
        continue;
      }
      const resolved = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (resolved === '..' || resolved.startsWith('../')) out.skipped.push({ path: entry.path, reason: 'symlink outside the artifact' });
      else out.symlinks.push({ path: entry.path, target: entry.target });
    } else out.skipped.push({ path: entry.path, reason: 'special file' });
  }
  return out;
}

export interface CollectedArtifact {
  artifact: HarborArtifact;
  /** The absolute sandbox path. */
  path: string;
  type: 'file' | 'directory';
  /** Harbor's manifest statuses. */
  status: 'ok' | 'failed' | 'empty' | 'skipped';
  /** Paths relative to `path` ('' for a file artifact). */
  files: Array<{ path: string; mode: number; bytes: Uint8Array<ArrayBuffer> }>;
  dirs: string[];
  symlinks: Array<{ path: string; target: string }>;
  skipped: Array<{ path: string; reason: string }>;
  error: string | null;
}

/** The trial folder's `artifacts/`: each file at its host destination, and `manifest.json`. Symlinks are listed, not stored. */
export function artifactFiles(collected: readonly CollectedArtifact[]): StoredFile[] {
  const out: StoredFile[] = [];
  for (const entry of collected) {
    const destination = hostDestination(entry.artifact, entry.path);
    for (const file of entry.files) {
      const path = posix.normalize(file.path ? `${destination}/${file.path}` : destination);
      if (path === 'manifest.json' || path.startsWith('../')) continue;
      out.push({ path: `artifacts/${path}`, content: file.bytes });
    }
  }
  out.push({
    path: 'artifacts/manifest.json',
    content: `${JSON.stringify(
      collected.map((entry) => ({
        source: entry.artifact.source,
        destination: hostDestination(entry.artifact, entry.path),
        type: entry.type,
        status: entry.status,
        exclude: entry.artifact.exclude,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.skipped.length ? { skipped: entry.skipped } : {}),
        ...(entry.symlinks.length ? { symlinks: entry.symlinks } : {}),
      })),
      null,
      2,
    )}\n`,
  });
  return out;
}
