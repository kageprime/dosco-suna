/**
 * Config release tree plumbing.
 *
 * Pure git plumbing over the API's bare mirror: resolve a commit's tree, list
 * its files, compose the release tree (the commit's whole tree, minus the
 * files it leaves out) in a scratch repository, and build its `tar.gz`. No caches, no store, no governance: the release orchestration
 * lives in `builder.ts`, which re-exports this module's public names. It never
 * calls into a sandbox.
 *
 * The mirror is a partial object store: it holds commits, and trees and files
 * only once a read asks for them. The scratch repository reads the mirror
 * through alternates and cannot fetch, so every read here first makes its
 * objects present: the trees of the commit, the `.gitattributes` files, the
 * tool modules it parses, and the files an archive packs.
 *
 * It runs in the tree threads (`tree-jobs.ts`), never on the API event loop:
 * its git, its object downloads and its scratch folder come from
 * `release-tree-git.ts`. The API process calls it directly only for one-call
 * checks (`isTreeObject`) and in tests.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { GitBackedProject } from '../projects/git/types';
import { isObjectFetchTooLarge } from '../shared/over-limit-memo';
import { bumpBounded } from '../shared/ttl-memo';
import { runGit, runProcess, scratchDir, treeObjects } from './release-tree-git';

/**
 * The release archive cap. A release is the repository's whole tree at the
 * commit (the company project: 248 files, 2.6 MB, 2026-10-05). The daemon's
 * `MAX_CONFIG_ARCHIVE_BYTES` must match.
 */
export const MAX_CONFIG_ARCHIVE_BYTES = 32 * 1024 * 1024;
/** Bound on the uncompressed tar, so a huge repository cannot exhaust memory before the cap trips. The daemon's `MAX_EXTRACTED_BYTES` must match. */
const MAX_CONFIG_TAR_BYTES = 128 * 1024 * 1024;

export const HEX40 = /^[0-9a-f]{40}$/;

/**
 * `project` compiles every agent. `agent:<name>` compiles one selected agent.
 * `none` compiles an EMPTY config (`{}`): the answer for a session with no
 * usable agent (config-releases/session-agent.ts). Its etag is non-null, so a
 * session whose agent the manifest dropped still gets a release ID and still
 * boots, instead of `release_id: null` and no config at all.
 * `meta` is the platform coordinator: the platform's own governance and no
 * config dir. Its box holds no project checkout and its image has no `bun`,
 * so a project config dir with tool dependencies can never load there.
 */
export type ConfigReleaseVariant = 'project' | 'none' | 'mykortix' | `agent:${string}` | `repo-agent:${string}`;

/**
 * The agent of a one-agent variant, or null. `agent:<name>` is the release of
 * a session without repository access (`exact` file list). `repo-agent:<name>`
 * is the per-agent release of a session with repository access (`folders`
 * file list): built, not yet assigned to any session
 * (`.agents/skills/learnings/work/per-agent-config-release/`).
 */
export function variantAgent(variant: ConfigReleaseVariant): string | null {
  if (variant.startsWith('agent:')) return variant.slice('agent:'.length);
  if (variant.startsWith('repo-agent:')) return variant.slice('repo-agent:'.length);
  return null;
}

/** One tracked file: `[path relative to the repository root, git mode, blob ID]`. */
export type ConfigReleaseFile = [path: string, mode: string, blob: string];

export class ConfigArchiveTooLargeError extends Error {
  constructor(
    readonly limit: number,
    /** The size that tripped a cap, when one was measured. */
    readonly actualBytes?: number,
  ) {
    super(`config archive exceeds ${limit} bytes`);
    this.name = 'ConfigArchiveTooLargeError';
  }
}

/**
 * The bound on the files an archive downloads into the mirror: the tar bound,
 * scaled with the archive cap (128 MiB for 32 MiB) so a test's smaller cap
 * needs no 128 MiB fixture. A pack is compressed and a tar is not, so a
 * download over this bound means a tar over `MAX_CONFIG_TAR_BYTES`.
 */
function archiveFetchLimit(limit: number): number {
  return Math.min(MAX_CONFIG_TAR_BYTES, limit * 4);
}

/**
 * Run `fetch` (an `ensure*` call bounded by `maxBytes`) before an archive.
 * A download over the bound keeps nothing and means the archive is too large.
 */
async function ensureArchiveObjects(limit: number, fetch: (maxBytes: number) => Promise<unknown>): Promise<void> {
  try {
    await fetch(archiveFetchLimit(limit));
  } catch (error) {
    if (isObjectFetchTooLarge(error)) throw new ConfigArchiveTooLargeError(limit, error.receivedBytes);
    throw error;
  }
}

/**
 * Make `oids` present in the store at `mirror`, and return the bytes received.
 * Only the ones it lacks are asked for: in a tree thread each request goes to
 * the API process (`release-tree-git.ts`), and most builds need none.
 */
async function ensureObjects(mirror: string, oids: readonly string[], options?: { maxBytes?: number; overLimitKey?: string }): Promise<number> {
  const wanted = [...new Set(oids)].filter((oid) => HEX40.test(oid));
  if (wanted.length === 0) return 0;
  const checked = (await gitStdin(mirror, {}, ['cat-file', '--batch-check=%(objectname)'], `${wanted.join('\n')}\n`)).toString('utf8');
  const missing: string[] = [];
  for (const line of checked.split('\n')) {
    const [oid, state] = line.split(' ');
    if (oid && state === 'missing') missing.push(oid);
  }
  return missing.length === 0 ? 0 : treeObjects().ensureObjects(mirror, missing, options);
}

/**
 * The root tree ID of `commit`, or null. Every tree of the commit is present
 * in the mirror afterwards, and no file: what `ls-tree -r` and `read-tree`
 * read. The ID comes from the commit object, because `rev-parse
 * <commit>^{tree}` fails while the tree has not arrived.
 */
export async function commitRootTree(mirror: string, commit: string): Promise<string | null> {
  await treeObjects().ensureCommitTrees(mirror, [commit]);
  const result = await runGit(['log', '--no-walk', '--format=%T', commit, '--'], mirror);
  const tree = result.stdout.trim();
  if (result.exitCode !== 0 || !HEX40.test(tree)) return null;
  return (await isTreeObject(mirror, tree)) ? tree : null;
}

/** Is `treeId` a tree object in the mirror? */
export async function isTreeObject(mirror: string, treeId: string): Promise<boolean> {
  if (!HEX40.test(treeId)) return false;
  const result = await runGit(['cat-file', '-t', treeId], mirror);
  return result.exitCode === 0 && result.stdout.trim() === 'tree';
}

/**
 * `git ls-tree -r -z <tree>`: every file with its mode and blob ID. A tree
 * entry of type `commit` (a submodule) is skipped. Symlinks keep mode 120000.
 */
export async function listConfigFiles(
  mirror: string,
  treeId: string,
  env?: Record<string, string>,
): Promise<ConfigReleaseFile[]> {
  const result = await runGit(['ls-tree', '-r', '-z', treeId], mirror, env);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree ${treeId} failed: ${result.stderr.trim()}`);
  }
  const files: ConfigReleaseFile[] = [];
  const out = result.stdout;
  const pace = pacer();
  // One record at a time, giving the event loop back as the characters add up: a commit may list 100,000+ files.
  for (let start = 0; start < out.length; ) {
    let end = out.indexOf('\0', start);
    if (end < 0) end = out.length;
    const record = out.slice(start, end);
    start = end + 1;
    await pace(record.length + 1);
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob' || !mode || !blob || !path) continue;
    files.push([path, mode, blob]);
  }
  // `ls-tree -r` lists in path order already: check it in a paced pass, and sort only when it is not.
  let sorted = true;
  for (let at = 1; at < files.length && sorted; at += 1) {
    await pace(files[at]![0].length);
    sorted = files[at - 1]![0] < files[at]![0];
  }
  // Git orders by bytes and JavaScript by UTF-16 units: they differ only for some non-ASCII paths.
  return sorted ? files : pacedSort(files, pace);
}

/**
 * `files` sorted by path, as a bottom-up merge sort that pays for every
 * comparison by the shorter path's length and gives the event loop back as
 * the work adds up: a crafted listing cannot buy one long synchronous sort.
 */
async function pacedSort(files: ConfigReleaseFile[], pace: (units: number) => Promise<void>): Promise<ConfigReleaseFile[]> {
  let from = files.slice();
  let to: ConfigReleaseFile[] = new Array(from.length);
  for (let width = 1; width < from.length; width *= 2) {
    for (let low = 0; low < from.length; low += 2 * width) {
      const middle = Math.min(low + width, from.length);
      const high = Math.min(low + 2 * width, from.length);
      let left = low;
      let right = middle;
      for (let out = low; out < high; out += 1) {
        if (left < middle && right < high) {
          const a = from[left]![0];
          const b = from[right]![0];
          await pace(Math.min(a.length, b.length) + 1);
          if (b < a) to[out] = from[right++]!;
          else to[out] = from[left++]!;
        } else if (left < middle) {
          to[out] = from[left++]!;
        } else {
          to[out] = from[right++]!;
        }
      }
    }
    [from, to] = [to, from];
  }
  return from;
}

/**
 * A pacer for a whole-tree pass with no work bound of its own (the listing is
 * bounded by `runGitCapture`'s 10 MiB output): call it with the characters
 * each step touches, and it gives the event loop back every `WORK_PER_YIELD`.
 */
function pacer(): (units: number) => Promise<void> {
  let sinceYield = 0;
  return async (units) => {
    sinceYield += units;
    if (sinceYield < WORK_PER_YIELD) return;
    sinceYield = 0;
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  };
}

const ARCHIVE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Dosco config release',
  GIT_AUTHOR_EMAIL: 'config-release@kortix.invalid',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'Dosco config release',
  GIT_COMMITTER_EMAIL: 'config-release@kortix.invalid',
  GIT_COMMITTER_DATE: '@0 +0000',
};

/**
 * A scratch bare repository that reads the mirror's objects through
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Two reasons:
 * - `info/attributes` neutralises `export-ignore` and `export-subst`. Without
 *   it a `.gitattributes` in the config dir drops or rewrites files, and blob
 *   verification on the box fails.
 * - The fixed-date wrapper commit is written here, so the mirror receives no
 *   writes.
 */
async function withScratchRepo<T>(mirror: string, fn: (repo: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const repo = await mkdtemp(join(scratchDir(), 'kortix-config-archive-'));
  try {
    const init = await runGit(['init', '--quiet', '--bare', repo], scratchDir());
    if (init.exitCode !== 0) throw new Error(`git init scratch repo failed: ${init.stderr.trim()}`);
    await mkdir(join(repo, 'info'), { recursive: true });
    await writeFile(join(repo, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    // The mirror is bare, so this is `<mirror>/objects`; asking git also
    // covers a non-bare repository.
    const objects = await runGit(['rev-parse', '--git-path', 'objects'], mirror);
    if (objects.exitCode !== 0) throw new Error(`git rev-parse --git-path objects failed: ${objects.stderr.trim()}`);
    const env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(mirror, objects.stdout.trim()), ...ARCHIVE_IDENTITY };
    return await fn(repo, env);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Build the `tar.gz` of a config tree: `git archive --format=tar` of a
 * fixed-date commit that wraps the tree, piped through `gzip -n`. `git archive`
 * of a bare tree stamps the current time; the wrapper commit carries mtime 0,
 * so two builds of one tree give identical bytes. Paths are relative to the
 * config dir root. Throws `ConfigArchiveTooLargeError` above `limit` bytes.
 */
export async function buildConfigArchive(
  mirror: string,
  treeId: string,
  limit = MAX_CONFIG_ARCHIVE_BYTES,
): Promise<Buffer> {
  if (!HEX40.test(treeId)) throw new Error(`invalid config tree id: ${treeId}`);
  // The tree itself, then its files. A fetch of this tree once over the bound is not tried again.
  await ensureObjects(mirror, [treeId]);
  const blobs = (await listConfigFiles(mirror, treeId)).map(([, , blob]) => blob);
  await ensureArchiveObjects(limit, (maxBytes) => ensureObjects(mirror, blobs, { maxBytes, overLimitKey: `tree:${treeId}` }));
  return withScratchRepo(mirror, (repo, env) => archiveTree(repo, env, treeId, limit));
}

async function archiveTree(
  repo: string,
  env: Record<string, string>,
  treeId: string,
  limit: number,
): Promise<Buffer> {
  const wrapped = await runGit(['commit-tree', treeId, '-m', 'config'], repo, env);
  const commit = wrapped.stdout.trim();
  if (wrapped.exitCode !== 0 || !HEX40.test(commit)) {
    throw new Error(`git commit-tree ${treeId} failed: ${wrapped.stderr.trim()}`);
  }
  return archiveThroughGzip(repo, commit, env, limit);
}

/**
 * What a release ships: the commit's whole tree, the same files and folders a
 * checkout of the base branch holds in `/workspace`. Nothing is moved: a file a
 * config refers to by a relative path (`skills/`, a tool or extension module)
 * is where the repository put it. The daemon reads the agents from the
 * compiled set, never from a harness config folder.
 *
 * Left out: files `.gitattributes` marks `export-ignore`, and a leftover
 * OpenCode config file (`LEFTOVER_OPENCODE_CONFIGS`), which would make the
 * release look like one a harness reads.
 */
export interface ReleaseTreeSource {
  /** The commit's root tree ID in the mirror. */
  rootTree: string;
  /** Files left out of the release. */
  exportIgnored: string[];
}

/** OpenCode config files of a retired project layout. A release never ships one. */
const LEFTOVER_OPENCODE_CONFIGS = ['harnesses/opencode', '.kortix/opencode'].flatMap((dir) =>
  ['opencode.jsonc', 'opencode.json'].map((name) => `${dir}/${name}`),
);

/**
 * Is the release tree composed, rather than the commit's own tree? A composed
 * tree exists in no mirror: its archive URL carries the commit, and the
 * archive route rebuilds it from there.
 */
export function isComposedSource(source: ReleaseTreeSource): boolean {
  return source.exportIgnored.length > 0;
}

/** `git <args>` in `repo` with NUL-terminated `records` on stdin. Throws on a non-zero exit. */
async function gitWithInput(
  repo: string,
  env: Record<string, string>,
  args: string[],
  records: string[],
): Promise<string> {
  return (await gitStdin(repo, env, args, records.map((record) => `${record}\0`).join(''))).toString('utf8');
}

/** The default bound on what one `gitStdin` call holds from stdout. */
const MAX_GIT_STDOUT_BYTES = 64 * 1024 * 1024;

/** What one `gitStdin` call may run: its job may run 60 s of its own time (`tree-jobs.ts`). */
const GIT_STDIN_TIMEOUT_MS = 60_000;

/**
 * `git <args>` in `repo` with `input` on stdin; its stdout bytes. Throws on a
 * non-zero exit. Output over `maxOutputBytes` kills the child and throws
 * `ConfigArchiveTooLargeError`: the API process never holds more than that
 * from one call, whatever the repository holds.
 */
async function gitStdin(repo: string, env: Record<string, string>, args: string[], input: string, maxOutputBytes = MAX_GIT_STDOUT_BYTES): Promise<Buffer> {
  // It may read the mirror (alternates), which must never fetch on its own: `childEnv` sets GIT_NO_LAZY_FETCH.
  const result = await runProcess({
    command: 'git',
    args,
    cwd: repo,
    env,
    input: new TextEncoder().encode(input),
    maxOutputBytes,
    timeoutMs: GIT_STDIN_TIMEOUT_MS,
  });
  if (result.overOutput) throw new ConfigArchiveTooLargeError(maxOutputBytes, result.stdoutBytes);
  if (result.timedOut) throw new Error(`git ${args[0]} failed: no answer in ${GIT_STDIN_TIMEOUT_MS} ms`);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
}

/**
 * The work one file-list build may do on repository content. Every axis an
 * author of the repository controls is counted, and the build stops with
 * `ConfigArchiveTooLargeError` past any of them: the caller then answers
 * "too large", and the session keeps the config it runs (or, for a
 * `repo-agent` release, the whole-tree release).
 *
 * `work` is charged in characters a loop actually touches (a prefix compare,
 * a candidate path, a directory prefix), never in events: a string the
 * repository chose cannot make one charged unit expensive. The build stops
 * after `MAX_LIST_MILLIS` of wall time, well inside the tree thread's own
 * limit (`tree-jobs.ts`). It gives its event loop back every
 * `WORK_PER_YIELD` units (`pace`): a call made in the API process itself (a
 * test, a measurement) never stalls it either.
 */
export class ListBudget {
  /** Bytes read from blobs. Every read blob ships, so the tar bound applies. */
  readBytes = MAX_CONFIG_TAR_BYTES;
  /** Bytes of code parsed for imports. */
  parseBytes = MAX_PARSED_CODE_BYTES;
  /** Bytes downloaded into a partial mirror. */
  downloadBytes = MAX_CONFIG_TAR_BYTES;
  /** Git round trips: one download, one size check or one batch read each. */
  gitCalls = MAX_LIST_GIT_CALLS;
  /** Characters of string work: compares, joins, lookups. */
  work = MAX_LIST_WORK;
  /** Folder hops of a `folders` walk: a file a new folder brought in importing yet another folder. */
  folderRounds = MAX_FOLDER_ROUNDS;
  private readonly startedAt = performance.now();
  private sinceYield = 0;

  spend(axis: 'readBytes' | 'parseBytes' | 'downloadBytes' | 'gitCalls' | 'work' | 'folderRounds', amount: number): void {
    this[axis] -= amount;
    if (axis === 'work') this.sinceYield += amount;
    if (this[axis] < 0) throw new ConfigArchiveTooLargeError(MAX_CONFIG_TAR_BYTES);
  }

  /** Charge `units` of string work, then `pace`. */
  async step(units: number): Promise<void> {
    this.spend('work', units);
    await this.pace();
  }

  /** Give the event loop back once enough work ran since the last time, and stop past the wall-time bound. */
  async pace(): Promise<void> {
    if (this.sinceYield < WORK_PER_YIELD) return;
    this.sinceYield = 0;
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    if (performance.now() - this.startedAt > MAX_LIST_MILLIS) throw new ConfigArchiveTooLargeError(MAX_CONFIG_TAR_BYTES);
  }

  /** `ensureObjects` for `oids`, charged to this build. */
  async download(mirror: string, oids: readonly string[]): Promise<void> {
    if (oids.length === 0) return;
    this.spend('gitCalls', 1);
    this.spend('downloadBytes', await ensureObjects(mirror, oids, { maxBytes: Math.max(1, this.downloadBytes) }));
  }
}

/** Characters of string work one build does at most. */
const MAX_LIST_WORK = 200_000_000;
/** Work between two returns to the event loop. */
const WORK_PER_YIELD = 200_000;
/** Wall time one build runs at most. */
const MAX_LIST_MILLIS = 20_000;
/** An import specifier longer than this resolves to nothing: no tool imports a path this long. */
const MAX_SPECIFIER_CHARS = 1_024;

/** Code one build parses for imports at most. */
const MAX_PARSED_CODE_BYTES = 32 * 1024 * 1024;
/** Git round trips one build makes at most. */
const MAX_LIST_GIT_CALLS = 512;

/**
 * A module larger than this ships but is never read to be parsed: Bun's import
 * scan takes ~9.5 ms per MiB of plain code (measured 2026-11-24) and up to
 * ~70 ms per MiB of code built to be slow (Strix), so one parse takes at most
 * ~35 ms.
 */
const MAX_PARSED_BLOB_BYTES = 512 * 1024;
/** The bytes one `git cat-file --batch` call returns at most. */
const MAX_BLOB_READ_CHUNK_BYTES = 32 * 1024 * 1024;

// replica-local: blob IDs over a read bound; a blob never changes, so a miss only checks its size again.
const oversizedBlobs = new Map<string, number>();

/**
 * The bytes of each blob of `blobs` the mirror holds and that is at most
 * `maxBlobBytes`, in as few `git cat-file --batch` calls as fit
 * `MAX_BLOB_READ_CHUNK_BYTES` each. The sizes are read first
 * (`--batch-check`), so a blob over the bound is never read, and it is
 * remembered by ID. Calls and bytes are charged to `budget`. A missing or
 * skipped blob is absent from the result.
 */
async function readBlobs(mirror: string, blobs: readonly string[], maxBlobBytes: number, budget: ListBudget): Promise<Map<string, Buffer>> {
  const wanted = [...new Set(blobs)].filter((blob) => HEX40.test(blob) && (oversizedBlobs.get(blob) ?? 0) <= maxBlobBytes);
  const out = new Map<string, Buffer>();
  if (wanted.length === 0) return out;
  budget.spend('gitCalls', 1);
  const sizes = (await gitStdin(mirror, {}, ['cat-file', '--batch-check'], `${wanted.join('\n')}\n`)).toString('utf8');
  const chunks: Array<{ ids: string[]; bytes: number }> = [];
  for (const line of sizes.split('\n')) {
    await budget.step(line.length + 1);
    const [oid, type, size] = line.split(' ');
    const bytes = Number(size);
    if (type !== 'blob' || !Number.isFinite(bytes)) continue;
    if (bytes > maxBlobBytes) {
      bumpBounded(oversizedBlobs, oid!, bytes, MAX_PARSED_IMPORTS);
      continue;
    }
    budget.spend('readBytes', bytes);
    const last = chunks.at(-1);
    if (last && last.bytes + bytes <= MAX_BLOB_READ_CHUNK_BYTES) {
      last.ids.push(oid!);
      last.bytes += bytes;
    } else {
      chunks.push({ ids: [oid!], bytes });
    }
  }
  for (const chunk of chunks) {
    budget.spend('gitCalls', 1);
    // Each record is a header line, the bytes and a newline: 128 bytes of slack per blob.
    const raw = await gitStdin(mirror, {}, ['cat-file', '--batch'], `${chunk.ids.join('\n')}\n`, chunk.bytes + chunk.ids.length * 128);
    let at = 0;
    while (at < raw.length) {
      const eol = raw.indexOf(0x0a, at);
      if (eol < 0) break;
      await budget.step(eol - at + 1);
      const [oid, type, size] = raw.subarray(at, eol).toString('utf8').split(' ');
      at = eol + 1;
      if (type === 'missing' || size === undefined) continue;
      const bytes = Number(size);
      if (type === 'blob') out.set(oid!, raw.subarray(at, at + bytes));
      at += bytes + 1;
    }
  }
  return out;
}

/** `tree` without `paths`, through a throwaway index in `repo`. */
async function pruneTree(repo: string, env: Record<string, string>, tree: string, paths: string[]): Promise<string> {
  const indexEnv = { ...env, GIT_INDEX_FILE: join(repo, 'release.index') };
  const read = await runGit(['read-tree', tree], repo, indexEnv);
  if (read.exitCode !== 0) throw new Error(`git read-tree ${tree} failed: ${read.stderr.trim()}`);
  // Mode 0 removes the entry. `--index-info` needs no work tree; `--force-remove` does.
  await gitWithInput(repo, indexEnv, ['update-index', '-z', '--index-info'], paths.map((path) => `0 ${'0'.repeat(40)}\t${path}`));
  // The tree ID needs the entries, not the files: the mirror may not hold them yet.
  const written = await runGit(['write-tree', '--missing-ok'], repo, indexEnv);
  const pruned = written.stdout.trim();
  if (written.exitCode !== 0 || !HEX40.test(pruned)) throw new Error(`git write-tree failed: ${written.stderr.trim()}`);
  return pruned;
}

/**
 * The release tree ID of `source`, written into `repo` (a scratch repository
 * that reads the mirror through alternates). With nothing left out it is the
 * commit's own root tree.
 */
async function composeReleaseTree(
  repo: string,
  env: Record<string, string>,
  source: ReleaseTreeSource,
): Promise<string> {
  if (source.exportIgnored.length === 0) return source.rootTree;
  return pruneTree(repo, env, source.rootTree, source.exportIgnored);
}

/**
 * The files of `rootTree` its `.gitattributes` marks `export-ignore`, on the
 * file or on one of its directories: what a plain `git archive` leaves out
 * (KRTX-1728). Paths `exempt` keeps are never listed.
 *
 * Read from a throwaway index (`check-attr --cached`), in a scratch repository
 * WITHOUT the archive's neutralising `info/attributes`. `check-attr --source`
 * would need git 2.40; the API image runs 2.39.
 */
async function exportIgnoredPaths(
  mirror: string,
  rootTree: string,
  exempt: (path: string) => boolean,
): Promise<string[]> {
  const files = await listConfigFiles(mirror, rootTree);
  const attributeFiles = files.filter(([path]) => path === '.gitattributes' || path.endsWith('/.gitattributes'));
  // Every slice and loop below is paid by its length: unique deep paths cannot make this quadratic for free.
  const budget = new ListBudget();
  // The attribute files are read here, in one batch, and by `check-attr` below.
  await budget.download(mirror, attributeFiles.map(([, , blob]) => blob));
  const attributes = await readBlobs(mirror, attributeFiles.map(([, , blob]) => blob), MAX_ATTRIBUTES_FILE_BYTES, budget);
  // The common case is no rule at all: no index, no scratch repository.
  let named = false;
  for (const bytes of attributes.values()) {
    await budget.step(bytes.length);
    if (bytes.includes('export-ignore')) named = true;
  }
  if (!named) return [];

  const candidates = files.map(([path]) => path).filter((path) => !exempt(path));
  // Every candidate and each folder above it, each folder added once: walk up from the
  // deepest folder and stop at the first one already present.
  const queriedSet = new Set<string>();
  for (const path of candidates) {
    await budget.step(path.length);
    queriedSet.add(path);
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
      await budget.step(slash);
      const dir = path.slice(0, slash);
      if (queriedSet.has(dir)) break;
      queriedSet.add(dir);
    }
  }
  const queried = [...queriedSet];
  const repo = await mkdtemp(join(scratchDir(), 'kortix-config-attributes-'));
  try {
    const init = await runGit(['init', '--quiet', '--bare', repo], scratchDir());
    if (init.exitCode !== 0) throw new Error(`git init scratch repo failed: ${init.stderr.trim()}`);
    const objects = await runGit(['rev-parse', '--git-path', 'objects'], mirror);
    if (objects.exitCode !== 0) throw new Error(`git rev-parse --git-path objects failed: ${objects.stderr.trim()}`);
    const env = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(mirror, objects.stdout.trim()),
      GIT_INDEX_FILE: join(repo, 'attributes.index'),
    };
    const read = await runGit(['read-tree', rootTree], repo, env);
    if (read.exitCode !== 0) throw new Error(`git read-tree ${rootTree} failed: ${read.stderr.trim()}`);
    // `-z` output: path NUL attribute NUL value NUL, per queried path.
    const out = (await gitWithInput(repo, env, ['check-attr', '--cached', '-z', '--stdin', 'export-ignore'], queried)).split('\0');
    const ignored = new Set<string>();
    for (let i = 0; i + 2 < out.length; i += 3) {
      await budget.step(out[i]!.length);
      if (out[i + 2] === 'set') ignored.add(out[i]!);
    }
    // Is a folder ignored, or under an ignored folder? Each folder is decided once.
    const ignoredDir = new Map<string, boolean>([['', false]]);
    const dirIgnored = async (dir: string): Promise<boolean> => {
      const chain: string[] = [];
      let at = dir;
      while (!ignoredDir.has(at)) {
        await budget.step(at.length);
        chain.push(at);
        const slash = at.lastIndexOf('/');
        at = slash < 0 ? '' : at.slice(0, slash);
      }
      let value = ignoredDir.get(at)!;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        value = value || ignored.has(chain[i]!);
        ignoredDir.set(chain[i]!, value);
      }
      return value;
    };
    const left: string[] = [];
    for (const path of candidates) {
      await budget.step(path.length);
      const slash = path.lastIndexOf('/');
      if (ignored.has(path) || (await dirIgnored(slash < 0 ? '' : path.slice(0, slash)))) left.push(path);
    }
    return left;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/** Compose the release tree of `source` in a scratch repository and read it there.
 *
 * `archive` builds the `tar.gz` too: a boolean, or a predicate over the
 * composed tree ID for callers that decide from the tree ID (the builder
 * skips the build when the archive size is already cached).
 */
export async function readComposedRelease(
  mirror: string,
  source: ReleaseTreeSource,
  options: { archive: boolean | ((treeId: string) => boolean); limit?: number },
): Promise<{ treeId: string; files: ConfigReleaseFile[]; archive: Buffer | null }> {
  return withScratchRepo(mirror, async (repo, env) => {
    const treeId = await composeReleaseTree(repo, env, source);
    const files = await listConfigFiles(repo, treeId, env);
    const wanted = typeof options.archive === 'function' ? options.archive(treeId) : options.archive;
    if (!wanted) return { treeId, files, archive: null };
    const limit = options.limit ?? MAX_CONFIG_ARCHIVE_BYTES;
    // Exactly the files that ship: an `export-ignore` path is never downloaded.
    await ensureArchiveObjects(limit, (maxBytes) => ensureObjects(mirror, files.map(([, , blob]) => blob), { maxBytes }));
    return { treeId, files, archive: await archiveTree(repo, env, treeId, limit) };
  });
}

/** A tree of exactly `files`, written in a scratch repository, and its `tar.gz` when `archive` asks for one. */
export async function readFileTree(
  mirror: string,
  files: readonly ConfigReleaseFile[],
  options: { archive: boolean | ((treeId: string) => boolean); limit?: number },
): Promise<{ treeId: string; archive: Buffer | null }> {
  return withScratchRepo(mirror, async (repo, env) => {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(repo, 'release.index') };
    await gitWithInput(repo, indexEnv, ['update-index', '-z', '--add', '--index-info'], files.map(([path, mode, blob]) => `${mode} ${blob}\t${path}`));
    // The tree ID needs the entries, not the files: the mirror may not hold them yet.
    const written = await runGit(['write-tree', '--missing-ok'], repo, indexEnv);
    const treeId = written.stdout.trim();
    if (written.exitCode !== 0 || !HEX40.test(treeId)) throw new Error(`git write-tree failed: ${written.stderr.trim()}`);
    const wanted = typeof options.archive === 'function' ? options.archive(treeId) : options.archive;
    if (!wanted) return { treeId, archive: null };
    const limit = options.limit ?? MAX_CONFIG_ARCHIVE_BYTES;
    await ensureArchiveObjects(limit, (maxBytes) => ensureObjects(mirror, files.map(([, , blob]) => blob), { maxBytes }));
    return { treeId, archive: await archiveTree(repo, env, treeId, limit) };
  });
}

/** What Bun tries, in order, for a relative import: the path, then each extension, then a directory index. */
const IMPORT_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** A file Bun parses for imports. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// replica-local: the import specifiers of a blob under a loader; a blob never changes, so a miss only parses it again.
const parsedImports = new Map<string, string[]>();

/** Tests and measurement: forget every parse and size memo, as a new API process would. */
export function __clearReleaseTreeMemosForTests(): void {
  parsedImports.clear();
  textReferences.clear();
  oversizedBlobs.clear();
}
// replica-local: the relative references of a skill text blob; a miss only reads it again.
const textReferences = new Map<string, string[]>();
const MAX_PARSED_IMPORTS = 20_000;

/** Every file of `rootTree`, by path. */
async function treeFiles(mirror: string, rootTree: string): Promise<Map<string, ConfigReleaseFile>> {
  return new Map((await listConfigFiles(mirror, rootTree)).map((file) => [file[0], file]));
}

/**
 * The files the modules `modules` load: each module and every file it imports
 * by a relative specifier, transitively, from `tree`. A package import is not
 * followed. A module that is not in the tree is left out, and the box reports
 * it as missing. Adds them to `found` and returns the ones it added: a file
 * already in `found` is never parsed again. A module over
 * `MAX_PARSED_BLOB_BYTES` ships but is not parsed.
 */
async function importClosure(
  mirror: string,
  tree: ReadonlyMap<string, ConfigReleaseFile>,
  modules: readonly string[],
  found: Map<string, ConfigReleaseFile>,
  budget: ListBudget,
): Promise<ConfigReleaseFile[]> {
  const added: ConfigReleaseFile[] = [];
  let queue = [...modules];
  // One round per import depth: one download and one read for the modules the round parses.
  while (queue.length > 0) {
    const round: ConfigReleaseFile[] = [];
    for (const path of queue) {
    const file = tree.get(path);
    if (!file || found.has(path)) continue;
    found.set(path, file);

      if (file[1] !== '120000' && !path.endsWith('.json')) round.push(file);
    }
    queue = [];
    // Memo hits are copied before the awaits below: another build may evict them meanwhile.
    const known = new Map<string, string[]>();
    const unparsed = new Set<string>();
    for (const [path, , blob] of round) {
      budget.spend('work', path.length + blob.length);
      await budget.pace();
      const key = importKey(blob, path);
      const hit = parsedImports.get(key);
      if (hit) known.set(key, hit);
      else unparsed.add(blob);
    }
    await budget.download(mirror, [...unparsed]);
    const sources = await readBlobs(mirror, [...unparsed], MAX_PARSED_BLOB_BYTES, budget);
    for (const [path, , blob] of round) {
      const source = await runGitCapture(['cat-file', 'blob', blob], mirror);
    const loader = path.endsWith('.tsx') ? 'tsx' : path.endsWith('.jsx') ? 'jsx' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js';
    let imports: Array<{ path: string }> = [];
    try {
      imports = new Bun.Transpiler({ loader }).scanImports(source.stdout);
    } catch {
      // A syntax error: the box reports it when it imports the module.

    }
    for (const { path: specifier } of imports) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const base = posix.normalize(posix.join(posix.dirname(path), specifier));
      // `./x.js` names `x.ts` in TypeScript, and Bun resolves it so.
      const candidates = [...IMPORT_SUFFIXES.map((suffix) => base + suffix), base.replace(/js$/, 'ts'), ...IMPORT_SUFFIXES.slice(1).map((suffix) => `${base}/index${suffix}`)];
      const target = candidates.find((candidate) => tree.has(candidate));
      if (target) queue.push(target);
    }
  }
  }
  return added;
}

/** The work one parse costs beyond its bytes: the scanner's fixed setup, in character units. */
const PARSE_OVERHEAD_UNITS = 32_768;

// replica-local: one import scanner per loader; scanImports keeps no state between calls.
const transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>();

/** The import scanner for `loader`, made once. */
function transpilerFor(loader: 'tsx' | 'jsx' | 'ts' | 'js'): InstanceType<typeof Bun.Transpiler> {
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  return transpiler;
}

/** The loader Bun parses a module at `path` with. */
function loaderOf(path: string): 'tsx' | 'jsx' | 'ts' | 'js' {
  return path.endsWith('.tsx') ? 'tsx' : path.endsWith('.jsx') ? 'jsx' : /\.[cm]?ts$/.test(path) ? 'ts' : 'js';
}

/** The memo key of a module's imports: they depend on its bytes and its loader, not on its path. */
function importKey(blob: string, path: string): string {
  return `${blob}\0${loaderOf(path)}`;
}

/**
 * How much of the repository a one-agent file list takes around what the
 * agent names.
 *
 * - `exact`: a session WITHOUT repository access. The tool modules and the
 *   files they import, nothing beside them: a file the agent may not use is
 *   never disclosed.
 * - `folders`: a session WITH repository access, which holds the whole
 *   checkout in `/workspace` anyway. Whole folders around every tool file, and
 *   the package and compiler config above them, so a tool that reads a file
 *   next to itself at run time still finds it. #9197 replaced a release that
 *   dropped such files; this list must never drop a file the agent reads.
 */
export type AgentFileScope = 'exact' | 'folders';

export interface AgentFileListInput {
  /** Repo-relative modules of the project tools an agent of the set may call. */
  toolModules: readonly string[];
  /** Repo-relative folders of the registered skills an agent of the set may load. */
  skillFolders: readonly string[];
  /** Repo-relative sources of the local pi packages an agent of the set enables: a file or a folder. */
  packageSources: readonly string[];
  /** Files taken whenever the tree holds them (the root `AGENTS.md`, the manifest). */
  rootFiles: readonly string[];
  scope: AgentFileScope;
}

/** The config files a tool's module resolution reads, in its folder or any folder above it. */
const RESOLUTION_FILES = [
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'bunfig.toml',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.npmrc',
];

/** The folder of a repo-relative path, with its trailing slash; `''` at the root. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut + 1);
}

/** `relative` resolved against the folder of `from`, or null when it leaves the repository or is not a path. */
function resolveRelative(from: string, relative: string): string | null {
  const clean = relative.split(/[?#]/)[0]!.trim();
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return null;
  const joined = posix.normalize(posix.join(folderOf(from), clean)).replace(/\/+$/, '');
  if (!joined || joined === '.' || joined === '..' || joined.startsWith('../')) return null;
  return joined;
}

/** The characters a path reference ends at. */
const REFERENCE_END = new Set([')', '(', '[', ']', '<', '>', '"', "'", '`', ' ', '\t', '\n', '\r']);
/** A `.gitattributes` larger than this is not read for `export-ignore`. */
const MAX_ATTRIBUTES_FILE_BYTES = 1024 * 1024;

/** The longest path reference read; a longer run ends the reference there. */
const MAX_REFERENCE_CHARS = 512;
/** The references read from one file at most. */
const MAX_REFERENCES_PER_FILE = 2_000;

/** Where a reference that starts at `start` ends: the first `REFERENCE_END` character, at most `MAX_REFERENCE_CHARS` on. */
function referenceEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + MAX_REFERENCE_CHARS);
  let end = start;
  while (end < limit && !REFERENCE_END.has(text[end]!)) end += 1;
  return end;
}

/**
 * Markdown link targets (`](x)`, `](<x>)`) and quoted `./x` / `../x` paths in
 * a text file. One linear pass per form with `indexOf`, never a backtracking
 * regex: the text is repository content, and the API parses it on its event
 * loop. Work per file is at most `MAX_REFERENCES_PER_FILE` references of
 * `MAX_REFERENCE_CHARS` each.
 */
function relativeReferences(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(']('); at >= 0 && out.length < MAX_REFERENCES_PER_FILE; at = text.indexOf('](', at + 2)) {
    let start = at + 2;
    while (start < text.length && (text[start] === ' ' || text[start] === '\t')) start += 1;
    if (text[start] === '<') start += 1;
    const end = referenceEnd(text, start);
    if (end > start) out.push(text.slice(start, end));
  }
  for (let at = text.indexOf('./'); at >= 0 && out.length < MAX_REFERENCES_PER_FILE; at = text.indexOf('./', at + 2)) {
    const start = text[at - 1] === '.' ? at - 1 : at;
    const quote = text[start - 1];
    if (quote !== '`' && quote !== "'" && quote !== '"') continue;
    const end = referenceEnd(text, start);
    if (end > start && text[end] === quote) out.push(text.slice(start, end));
  }
  return out;
}

/** A text file a skill may link from. */
const SKILL_TEXT_FILE = /\.(?:md|mdx|txt)$/i;
/** A skill text file larger than this is not scanned for links. */
const MAX_SCANNED_TEXT_BYTES = 256 * 1024;
/** The tool folders one `folders` build takes at most; more makes the release too large. */
const MAX_TOOL_FOLDERS = 2_000;
/** The folders one build walks at most (skills, packages, link targets, tool folders), each once. */
const MAX_WALKED_FOLDERS = 4_000;
/**
 * The folder hops one `folders` build follows at most: each round is a file a
 * new folder brought in importing yet another folder. More makes the release
 * too large, and the session keeps the whole-tree release.
 */
const MAX_FOLDER_ROUNDS = 64;

/**
 * The files one agent's release holds (see `AgentFileScope`), from the root
 * tree `rootTree`:
 *
 * - each of `rootFiles` the tree holds;
 * - every file under each skill folder, and under each package folder (a
 *   package that is one file is its folder, as the box reads it, except at
 *   the repository root);
 * - each tool module and every file it imports by a relative specifier;
 * - every path a skill's text files link to by a relative path (a file, or
 *   every file under a folder), as the model reads the skill from the release;
 * - `folders` only: every file under the folder of each tool file (never the
 *   repository root), the files those import, and the module-resolution
 *   config (`RESOLUTION_FILES`) in each folder from there up to the root.
 *
 * Paths never move: each file keeps the path the repository gives it.
 *
 * Bounded work on repository content: path lookups by range over the sorted
 * tree, each folder walked once, link scanning without a backtracking regex
 * (`relativeReferences`), at most `MAX_PARSED_BLOB_BYTES` per parsed module
 * and `MAX_SCANNED_TEXT_BYTES` per scanned text file, and one `ListBudget`
 * for the whole build (bytes read, parsed and downloaded, git round trips,
 * characters of string work, wall time). Every loop over repository content
 * gives the event loop back (`ListBudget.pace`). Past `MAX_WALKED_FOLDERS`,
 * `MAX_TOOL_FOLDERS`, `MAX_FOLDER_ROUNDS` or any budget axis it throws
 * `ConfigArchiveTooLargeError`.
 */
export async function agentReleaseFiles(mirror: string, rootTree: string, input: AgentFileListInput, budget = new ListBudget()): Promise<ConfigReleaseFile[]> {
  const tree = await treeFiles(mirror, rootTree);
  // `listConfigFiles` sorts by path: every file under a folder is one range of `paths`.
  const paths = [...tree.keys()];
  /** Every file under `folder`, in path order. Each visit compares `folder.length` characters and pays for them. */
  const filesUnder = async (folder: string, visit: (file: ConfigReleaseFile) => void): Promise<void> => {
    if (!folder) return;
    let low = 0;
    let high = paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      budget.spend('work', folder.length);
      if (paths[middle]! < folder) low = middle + 1;
      else high = middle;
    }
    for (let at = low; at < paths.length; at += 1) {
      budget.spend('work', folder.length);
      if (!paths[at]!.startsWith(folder)) break;
      visit(tree.get(paths[at]!)!);
      await budget.pace();
    }
  };
  const out = new Map<string, ConfigReleaseFile>();
  const take = (file: ConfigReleaseFile | undefined) => {
    if (file) out.set(file[0], file);
  };
  // Each folder is walked once.
  const walked = new Set<string>();
  const underFolder = async (folder: string, visit: (file: ConfigReleaseFile) => void = take): Promise<void> => {
    if (!folder || walked.has(folder)) return;
    walked.add(folder);
    if (walked.size > MAX_WALKED_FOLDERS) throw new ConfigArchiveTooLargeError(MAX_CONFIG_TAR_BYTES);
    await filesUnder(folder, visit);
  };
  const folderOrFile = async (path: string): Promise<void> => {
    budget.spend('work', path.length);
    if (tree.has(path)) take(tree.get(path));
    else await underFolder(`${path}/`);
  };

  for (const path of input.rootFiles) take(tree.get(path));

  const skillPrefixes = input.skillFolders.flatMap((folder) => {
    const clean = posix.normalize(folder.trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    return !clean || clean === '.' || clean.startsWith('../') || clean === '..' || clean.startsWith('/') ? [] : [`${clean}/`];
  });
  // The skill text files are collected as their folders are walked: no file is compared with every
  // skill folder, and a file under two nested skill folders counts once.
  const textsByPath = new Map<string, ConfigReleaseFile>();
  for (const prefix of skillPrefixes) {
    await underFolder(prefix, (file) => {
      take(file);
      budget.spend('work', file[0].length);
      if (file[1] !== '120000' && SKILL_TEXT_FILE.test(file[0])) textsByPath.set(file[0], file);
    });
  }
  const texts = [...textsByPath.values()];

  for (const source of input.packageSources) {
    const clean = resolveRelative('', source);
    if (!clean) continue;
    if (tree.has(clean) && /\.[cm]?[jt]sx?$/.test(clean)) {
      const folder = folderOf(clean);
      if (folder) await underFolder(folder);
      else take(tree.get(clean));
    } else {
      await folderOrFile(clean);
    }
  }

  // The links of every skill text file. The blobs ship anyway; a blob is read once per process.
  // Memo hits are copied before the awaits below: another build may evict them meanwhile.
  const links = new Map<string, string[]>();
  for (const [, , blob] of texts) {
    budget.spend('work', blob.length);
    await budget.pace();
    const hit = textReferences.get(blob);
    if (hit) links.set(blob, hit);
  }
  const unread = [...new Set(texts.map(([, , blob]) => blob).filter((blob) => !links.has(blob)))];
  if (unread.length > 0) {
    await budget.download(mirror, unread);
    const read = await readBlobs(mirror, unread, MAX_SCANNED_TEXT_BYTES, budget);
    // A blob over the bound links nothing; one that did not arrive is asked again next time.
    for (const blob of unread) {
      const bytes = read.get(blob);
      if (!bytes) continue;
      budget.spend('work', bytes.length);
      const references = relativeReferences(bytes.toString('utf8'));
      bumpBounded(textReferences, blob, references, MAX_PARSED_IMPORTS);
      links.set(blob, references);
      await budget.pace();
    }
  }
  const applied = new Set<string>();
  for (const [path, , blob] of texts) {
    for (const reference of links.get(blob) ?? []) {
      budget.spend('work', path.length + reference.length);
      const target = resolveRelative(path, reference);
      if (target && !applied.has(target)) {
        applied.add(target);
        await folderOrFile(target);
      }
      await budget.pace();
    }
  }

  const tools = new Map<string, ConfigReleaseFile>();
  let added = await importClosure(mirror, tree, input.toolModules, tools, budget);
  if (input.scope === 'folders') {
    // A worklist: each folder is taken once, and only the code files it adds are parsed.
    const folders = new Set<string>();
    while (added.length > 0) {
      budget.spend('folderRounds', 1);
      const code: string[] = [];
      for (const [path] of added) {
        const folder = folderOf(path);
        budget.spend('work', path.length);
        if (!folder || folders.has(folder)) continue;
        folders.add(folder);
        if (folders.size > MAX_TOOL_FOLDERS) throw new ConfigArchiveTooLargeError(MAX_CONFIG_TAR_BYTES);
        await filesUnder(folder, ([candidate]) => {
          if (CODE_FILE.test(candidate) && !tools.has(candidate)) code.push(candidate);
        });
      }
      added = await importClosure(mirror, tree, code, tools, budget);
    }
    for (const folder of folders) await underFolder(folder);
    // Every folder from a tool file up to the root, built prefix by prefix and paid by its length.
    const dirs = new Set<string>(['']);
    for (const path of tools.keys()) {
      for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
        budget.spend('work', slash);
        dirs.add(path.slice(0, slash));
      }
      await budget.pace();
    }
    for (const dir of dirs) {
      budget.spend('work', (dir.length + 16) * RESOLUTION_FILES.length);
      for (const name of RESOLUTION_FILES) take(tree.get(dir ? `${dir}/${name}` : name));
      await budget.pace();
    }
  }
  for (const file of tools.values()) take(file);

  // In tree order, from the sorted listing: no sort compares two long paths.
  const listed: ConfigReleaseFile[] = [];
  for (const path of paths) {
    // A lookup hashes the whole path.
    await budget.step(path.length);
    const file = out.get(path);
    if (file) listed.push(file);
  }
  return listed;
}

/**
 * The release tree source of `commit`. Shared by the builder and the archive
 * route, which rebuilds a composed tree from the commit in its path.
 */
export async function resolveReleaseTreeSource(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  commit: string,
): Promise<{ source: ReleaseTreeSource } | { reason: string }> {
  const rootTree = await commitRootTree(mirror, commit);
  if (!rootTree) return { reason: `commit ${commit} has no tree` };
  // The manifest's own `.gitattributes` entry must not drop it.
  const exportIgnored = await exportIgnoredPaths(mirror, rootTree, (path) => path === project.manifestPath);
  for (const path of LEFTOVER_OPENCODE_CONFIGS) {
    // Resolved from the tree alone: `cat-file -e` also needs the file, which
    // a partial mirror may not hold, and would answer "absent".
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `${commit}:${path}`], mirror);
    if (exists.exitCode === 0 && !exportIgnored.includes(path)) exportIgnored.push(path);
  }
  return { source: { rootTree, exportIgnored } };
}

/**
 * `git archive -o` to a file, then `gzip -n` on that file. Both write to disk:
 * piping one Bun child process into another truncated a 4 MiB archive to
 * 982,058 bytes with exit code 0 (measured 2026-09-21), the same failure class
 * `materializeRepoContext` avoids with a temporary tarball.
 */
async function archiveThroughGzip(
  repo: string,
  commit: string,
  env: Record<string, string>,
  limit: number,
): Promise<Buffer> {
  const tarPath = join(repo, 'config.tar');
  const archived = await runGit(['archive', '--format=tar', '-o', tarPath, commit], repo, env);
  if (archived.exitCode !== 0) throw new Error(`git archive ${commit} failed: ${archived.stderr.trim()}`);
  const tarBytes = (await stat(tarPath)).size;
  if (tarBytes > MAX_CONFIG_TAR_BYTES) throw new ConfigArchiveTooLargeError(limit, tarBytes);
  const gzipped = await runProcess({ command: 'gzip', args: ['-n', '-f', tarPath], cwd: repo, maxOutputBytes: 64 * 1024, timeoutMs: 60_000 });
  if (gzipped.exitCode !== 0) {
    throw new Error(`gzip -n failed: ${gzipped.timedOut ? 'no answer in 60000 ms' : gzipped.stderr.trim() || `exit ${gzipped.exitCode}`}`);
  }
  // Read once and measure the bytes read: a stat followed by a read can see
  // two different files (CodeQL js/file-system-race).
  const gz = await readFile(`${tarPath}.gz`);
  if (gz.length > limit) throw new ConfigArchiveTooLargeError(limit, gz.length);
  return gz;
}
