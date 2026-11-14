import { readFileSync } from 'node:fs';

/**
 * The `files` array of one JSON list file; empty when the file is missing,
 * unreadable, or holds no array. The one parser behind every `{files:[...]}`
 * list in packages/db.
 */
export function loadFileList<T>(path: string): T[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { files?: T[] };
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
}

export function loadFileSet(path: string): Set<string> {
  return new Set(loadFileList<string>(path));
}
