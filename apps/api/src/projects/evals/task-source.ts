/**
 * Where task files are read from.
 *
 *   repo: a path in the project repository, at the job's commit.
 *   git:  a path in a public git repository at a pinned commit. A dataset of the
 *         Harbor registry (`terminal-bench@2.0`) is a list of these.
 *
 * A git source is fetched once per (url, commit) into a bare repository under
 * the temp dir of the process (`fetch --depth 1`), then read with `ls-tree`
 * and `cat-file`. Each process keeps its own copy; a missing one is fetched again.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVAL_LIMITS, type EvalTaskSource } from '@kortix/api-contract';
import { RELEASE_COMMIT } from '../../config';
import { ttlMemo } from '../../shared/ttl-memo';
import { listRepoDirectory, listRepoFiles, readRepoFileBytes, type GitBackedProject } from '../git';
import { runGit, runGitBuffer } from '../git/mirror';
import { HarborTaskError, parseHarborTask, taskNameMatches, type HarborTask } from './harbor-task';
import { EvalTrialError } from './scoring';

/** Stored on a trial (`eval_trials.task_ref`): where its task is. */
export type EvalTaskRef =
  | { kind: 'repo'; path: string; source?: string }
  | { kind: 'git'; git_url: string; commit: string; path: string; source?: string };

export const taskRefLabel = (ref: EvalTaskRef): string =>
  ref.kind === 'repo' ? ref.path : `${ref.git_url.replace(/^https:\/\//, '').replace(/\.git$/, '')}@${ref.commit.slice(0, 7)}:${ref.path}`;

export interface TaskFile {
  /** Path relative to the folder that was read. */
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Reads the files of one tree: the project repository at a commit, or a fetched git repository. */
export interface TaskTree {
  /** Every file path under `path` (all files when empty). */
  list(path: string): Promise<string[]>;
  /** Every file under `path` with its size in bytes. */
  listSized(path: string): Promise<Array<{ path: string; size: number }>>;
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const under = (path: string, folder: string) => !folder || path === folder || path.startsWith(`${folder}/`);

export function projectTree(project: GitBackedProject, commit: string): TaskTree {
  return {
    async list(path) {
      return (await listRepoFiles(project, commit, path || null)).map((entry) => entry.path);
    },
    async listSized(path) {
      // One level at a time: the directory listing carries blob sizes. A blob the store has not fetched has none (0).
      const out: Array<{ path: string; size: number }> = [];
      const folders = [path];
      while (folders.length && out.length < 2_000) {
        const folder = folders.shift()!;
        const { entries } = await listRepoDirectory(project, commit, folder || null, { limit: 2_000 });
        for (const entry of entries) {
          if (entry.type === 'directory') folders.push(entry.path);
          else out.push({ path: entry.path, size: entry.size ?? 0 });
        }
      }
      return out;
    },
    async read(path) {
      const bytes = await readRepoFileBytes(project, path, commit);
      return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    },
  };
}

// ── Public git repositories ──────────────────────────────────────────────────

/** Hosts a registry dataset may live on. Fetches carry no credential. */
const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'huggingface.co']);
const GIT_FETCH_TIMEOUT_MS = 5 * 60_000;

function checkedGitUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EvalTrialError('TaskLoadError', `Not a git URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !GIT_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new EvalTrialError('TaskLoadError', `Tasks are read only from public https repositories on ${[...GIT_HOSTS].join(', ')}: ${url}`);
  }
  return parsed.toString();
}

const checkedCommit = (commit: string): string => {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new EvalTrialError('TaskLoadError', `Not a full commit SHA: ${commit}`);
  return commit.toLowerCase();
};

// replica-local: in-flight fetches of this process, so two trials of one dataset share one `git fetch`.
const fetching = new Map<string, Promise<string>>();

const GIT_CACHE = join(tmpdir(), 'kortix-evals-git');
/** Fetched repositories kept on disk per process; the least recently read go first. */
const GIT_CACHE_MAX = 24;

/** Keep the `GIT_CACHE_MAX` most recently read repositories, delete the rest. */
async function evictGitCache(keep: string): Promise<void> {
  const names = await readdir(GIT_CACHE).catch(() => [] as string[]);
  if (names.length <= GIT_CACHE_MAX) return;
  const aged = await Promise.all(
    names.map(async (name) => ({ dir: join(GIT_CACHE, name), at: await stat(join(GIT_CACHE, name, 'kortix-fetched')).then((info) => info.mtimeMs, () => 0) })),
  );
  const old = aged.filter((entry) => entry.dir !== keep && !fetching.has(entry.dir)).sort((a, b) => a.at - b.at);
  await Promise.all(old.slice(0, names.length - GIT_CACHE_MAX).map((entry) => rm(entry.dir, { recursive: true, force: true })));
}

async function fetchedRepo(gitUrl: string, commit: string): Promise<string> {
  const url = checkedGitUrl(gitUrl);
  const sha = checkedCommit(commit);
  const dir = join(GIT_CACHE, createHash('sha256').update(`${url}\n${sha}`).digest('hex').slice(0, 32));
  const ready = join(dir, 'kortix-fetched');
  if (await stat(ready).then(() => true, () => false)) {
    // The marker's mtime is the last read, for eviction.
    const now = new Date();
    await utimes(ready, now, now).catch(() => undefined);
    return dir;
  }
  const inFlight = fetching.get(dir);
  if (inFlight) return inFlight;
  const run = (async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      await runGit(['init', '--bare', '--quiet'], dir, false);
      await runGit(['fetch', '--quiet', '--depth', '1', url, sha], dir, false, null, undefined, 'github.com', GIT_FETCH_TIMEOUT_MS);
      await Bun.write(ready, sha);
      await evictGitCache(dir).catch(() => undefined);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw new EvalTrialError('TaskLoadError', `Could not fetch ${url} at ${sha.slice(0, 7)}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
    }
    return dir;
  })().finally(() => fetching.delete(dir));
  fetching.set(dir, run);
  return run;
}

export function gitTree(gitUrl: string, commit: string): TaskTree {
  const sha = checkedCommit(commit);
  return {
    async list(path) {
      const dir = await fetchedRepo(gitUrl, sha);
      const args = ['ls-tree', '-r', '-z', '--name-only', sha, '--'];
      if (path) args.push(path);
      const { stdout } = await runGit(args, dir, false);
      return stdout.split('\0').filter(Boolean);
    },
    async listSized(path) {
      const dir = await fetchedRepo(gitUrl, sha);
      const args = ['ls-tree', '-r', '-z', '-l', sha, '--'];
      if (path) args.push(path);
      const { stdout } = await runGit(args, dir, false);
      // `<mode> <type> <object> <size>\t<path>`
      return stdout.split('\0').filter(Boolean).flatMap((line) => {
        const tab = line.indexOf('\t');
        const size = Number(line.slice(0, tab).trim().split(/\s+/)[3]);
        return tab > 0 ? [{ path: line.slice(tab + 1), size: Number.isFinite(size) ? size : 0 }] : [];
      });
    },
    async read(path) {
      const dir = await fetchedRepo(gitUrl, sha);
      const { stdout } = await runGitBuffer(['cat-file', 'blob', `${sha}:${path}`], dir, false, null, undefined, 'github.com', 60_000, undefined, EVAL_LIMITS.task_folder_bytes_max * 2);
      return new Uint8Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) as ArrayBuffer);
    },
  };
}

/** A branch, tag or commit of a public repository, as a full commit SHA (`git ls-remote`). */
export async function resolveGitRef(gitUrl: string, ref: string | null | undefined): Promise<string> {
  const url = checkedGitUrl(gitUrl);
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const wanted = ref?.trim() || 'HEAD';
  let stdout: string;
  try {
    ({ stdout } = await runGit(['ls-remote', url, wanted, `refs/heads/${wanted}`, `refs/tags/${wanted}`], undefined, false, null, undefined, 'github.com', 60_000));
  } catch (err) {
    throw new EvalTrialError('TaskLoadError', `Could not read ${url}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  const sha = stdout.split('\n').map((line) => line.split('\t')[0]?.trim()).find((value) => value && /^[0-9a-f]{40}$/.test(value));
  if (!sha) throw new EvalTrialError('TaskLoadError', `${url} has no branch, tag or commit "${wanted}".`);
  return sha;
}

export const treeFor = (project: GitBackedProject, commit: string, ref: EvalTaskRef): TaskTree =>
  ref.kind === 'repo' ? projectTree(project, commit) : gitTree(ref.git_url, ref.commit);

// ── Tasks ────────────────────────────────────────────────────────────────────

async function readOptional(tree: TaskTree, paths: readonly string[], path: string): Promise<string | null> {
  return paths.includes(path) ? text(await tree.read(path)) : null;
}

/** Parse the task at `folder` of a tree whose file list is `paths`. */
async function loadTaskAt(tree: TaskTree, paths: readonly string[], folder: string): Promise<HarborTask> {
  const prefix = folder ? `${folder}/` : '';
  const inFolder = paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  return parseHarborTask({
    folderName: folder.split('/').pop() || 'task',
    taskToml: await readOptional(tree, paths, `${prefix}task.toml`),
    instruction: await readOptional(tree, paths, `${prefix}instruction.md`),
    dockerfile: await readOptional(tree, paths, `${prefix}environment/Dockerfile`),
    paths: inFolder,
  });
}

/** The task a trial runs, read again at run time. */
export async function loadTask(tree: TaskTree, ref: EvalTaskRef): Promise<HarborTask> {
  try {
    return await loadTaskAt(tree, await tree.list(ref.path), ref.path);
  } catch (err) {
    if (err instanceof EvalTrialError) throw err;
    throw new EvalTrialError('TaskLoadError', err instanceof Error ? err.message : String(err));
  }
}

/** The files of one folder of a task (`tests`, `solution`), within the size limit. */
export async function loadTaskFolder(tree: TaskTree, ref: EvalTaskRef, folder: 'tests' | 'solution'): Promise<TaskFile[]> {
  const root = `${ref.path ? `${ref.path}/` : ''}${folder}`;
  const paths = (await tree.list(root)).filter((path) => under(path, root));
  const files: TaskFile[] = [];
  let total = 0;
  for (const path of paths) {
    const bytes = await tree.read(path);
    total += bytes.byteLength;
    if (total > EVAL_LIMITS.task_folder_bytes_max) {
      throw new EvalTrialError('TaskLoadError', `${root} is larger than ${EVAL_LIMITS.task_folder_bytes_max / 1024 / 1024} MB.`);
    }
    files.push({ path: path.slice(root.length + 1), bytes });
  }
  return files;
}

export interface DiscoveredTask {
  ref: EvalTaskRef;
  task: HarborTask | null;
  /** Why the folder is not a task, when `task` is null. */
  error: string | null;
}

/**
 * The tasks under a path of a tree: the path itself when it holds `task.toml`,
 * else every folder below it that does (a task inside another task is skipped).
 */
export async function discoverTasks(
  tree: TaskTree,
  path: string,
  toRef: (taskPath: string) => EvalTaskRef,
): Promise<DiscoveredTask[]> {
  const root = path.replace(/^\.?\/+|\/+$/g, '');
  const paths = (await tree.list(root)).filter((file) => under(file, root));
  const folders = paths
    .filter((file) => file === 'task.toml' || file.endsWith('/task.toml'))
    .map((file) => file.slice(0, Math.max(0, file.length - '/task.toml'.length)))
    .sort();
  const top = folders.filter((folder) => !folders.some((other) => other !== folder && under(folder, other) && other.length < folder.length));
  const out: DiscoveredTask[] = [];
  for (const folder of top) {
    try {
      out.push({ ref: toRef(folder), task: await loadTaskAt(tree, paths, folder), error: null });
    } catch (err) {
      if (!(err instanceof HarborTaskError)) throw err;
      out.push({ ref: toRef(folder), task: null, error: err.message });
    }
  }
  return out;
}

/** Apply a source's `task_names`, `exclude_task_names` and `n_tasks`, in name order. */
export function filterTasks(tasks: DiscoveredTask[], source: Pick<EvalTaskSource, 'task_names' | 'exclude_task_names' | 'n_tasks'>): DiscoveredTask[] {
  const nameOf = (entry: DiscoveredTask) => entry.task?.name ?? entry.ref.path.split('/').pop() ?? entry.ref.path;
  let kept = [...tasks].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (source.task_names?.length) kept = kept.filter((entry) => source.task_names!.some((pattern) => taskNameMatches(nameOf(entry), pattern)));
  if (source.exclude_task_names?.length) kept = kept.filter((entry) => !source.exclude_task_names!.some((pattern) => taskNameMatches(nameOf(entry), pattern)));
  if (source.n_tasks) kept = kept.slice(0, source.n_tasks);
  return kept;
}

// ── The Harbor registry ──────────────────────────────────────────────────────

/** Harbor's dataset registry: dataset → tasks, each a git url, a commit and a path. */
const HARBOR_REGISTRY_URL = 'https://raw.githubusercontent.com/harbor-framework/harbor/main/registry.json';

interface RegistryDataset {
  name: string;
  version: string;
  description?: string;
  tasks: Array<{ name?: string; git_url?: string | null; git_commit_id?: string | null; path: string }>;
}

const loadRegistry = ttlMemo<[], RegistryDataset[]>({
  ttlMs: 10 * 60_000,
  keyFn: () => 'registry',
  loader: async () => {
    const res = await fetch(HARBOR_REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new EvalTrialError('TaskLoadError', `The Harbor registry answered ${res.status}.`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new EvalTrialError('TaskLoadError', 'The Harbor registry is not a list of datasets.');
    return body as RegistryDataset[];
  },
});

// ── Built-in datasets ────────────────────────────────────────────────────────

/** The repository Kortix itself is built from: built-in datasets are folders of it. */
const KORTIX_REPO = 'https://github.com/kortix-ai/suna.git';

/**
 * Datasets Kortix ships, available by name in every project (`datasets: [{ name: kortix/my-kortix }]`)
 * the way built-in agents are. Each is a folder of the Kortix repository, read at the commit the
 * running API was built from, so the tasks always match the deployed code.
 */
export const BUILTIN_DATASETS: Record<string, { path: string; description: string }> = {
  'kortix/my-kortix': {
    path: 'evals/my-kortix',
    description: 'What people ask My Kortix to do: answer, analyze, write a file, ask when a request is ambiguous, schedule a Loop. Run it before and after any change to My Kortix.',
  },
};

export const isBuiltinDataset = (name: string): boolean => Object.hasOwn(BUILTIN_DATASETS, name);

/** The ref of the Kortix repository built-in datasets are read at: the release commit, else `dev`. */
export const builtinDatasetRef = (): string => (/^[0-9a-f]{40}$/i.test(RELEASE_COMMIT) ? RELEASE_COMMIT : 'dev');

/** A built-in dataset as a git source. */
export function builtinDatasetSource(name: string, version?: string | null): { git_url: string; git_commit_id: string; path: string } {
  const dataset = BUILTIN_DATASETS[name];
  if (!dataset) throw new EvalTrialError('TaskLoadError', `There is no built-in dataset named ${name}. Built-in datasets: ${Object.keys(BUILTIN_DATASETS).join(', ')}.`);
  // `version` pins another commit, branch or tag of the Kortix repository.
  return { git_url: KORTIX_REPO, git_commit_id: version || builtinDatasetRef(), path: dataset.path };
}

// replica-local: task counts of built-in datasets by `name@ref`, filled when a count finishes (null: the folder is not at that ref).
const builtinCounts = new Map<string, number | null>();
// replica-local: counts in flight, so a burst of catalog reads starts one fetch.
const counting = new Map<string, Promise<void>>();

/** Count a built-in dataset's tasks in the background; the catalog shows null until the count lands. */
function builtinTaskCount(name: string): number | null {
  const key = `${name}@${builtinDatasetRef()}`;
  if (builtinCounts.has(key)) return builtinCounts.get(key) ?? null;
  if (!counting.has(key)) {
    const run = (async () => {
      const source = builtinDatasetSource(name);
      const sha = await resolveGitRef(source.git_url, source.git_commit_id);
      const paths = await gitTree(source.git_url, sha).list(source.path);
      const count = paths.filter((path) => path.endsWith('/task.toml')).length;
      // No task at the ref (the folder ships with a later commit): unknown, never 0.
      builtinCounts.set(key, count > 0 ? count : null);
    })()
      .catch(() => undefined)
      .finally(() => counting.delete(key));
    counting.set(key, run);
  }
  return null;
}

/** Record a built-in dataset's task count from a task list read at the ref the catalog uses. */
export function rememberBuiltinTaskCount(name: string, version: string | null | undefined, count: number): void {
  if ((!version || version === builtinDatasetRef()) && count > 0) builtinCounts.set(`${name}@${builtinDatasetRef()}`, count);
}

export interface EvalDatasetSummary {
  name: string;
  version: string;
  versions: string[];
  kind: 'builtin' | 'registry';
  description: string;
  n_tasks: number | null;
}

/**
 * The datasets a job can name: Kortix's built-in datasets first, then the
 * Harbor registry, one row per dataset with its versions newest first. No
 * dataset is read: a built-in dataset's task count is null until a background
 * count lands. A registry that does not answer leaves `registry_error`.
 */
export async function listEvalDatasets(): Promise<{ datasets: EvalDatasetSummary[]; registry_error: string | null }> {
  const builtins: EvalDatasetSummary[] = Object.entries(BUILTIN_DATASETS).map(([name, dataset]) => ({
    name,
    version: builtinDatasetRef(),
    versions: [builtinDatasetRef()],
    kind: 'builtin',
    description: dataset.description,
    n_tasks: builtinTaskCount(name),
  }));
  let registry: RegistryDataset[] = [];
  let registryError: string | null = null;
  try {
    registry = await loadRegistry();
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
  }
  // The registry lists versions oldest first; a job without one runs the last.
  const byName = new Map<string, RegistryDataset[]>();
  for (const dataset of registry) byName.set(dataset.name, [...(byName.get(dataset.name) ?? []), dataset]);
  const listed: EvalDatasetSummary[] = [...byName.entries()].map(([name, versions]) => {
    const latest = versions[versions.length - 1]!;
    return {
      name,
      version: String(latest.version),
      versions: versions.map((entry) => String(entry.version)).reverse(),
      kind: 'registry',
      description: latest.description ?? '',
      n_tasks: Array.isArray(latest.tasks) ? latest.tasks.length : null,
    };
  });
  return { datasets: [...builtins, ...listed], registry_error: registryError };
}

/** How many tasks a registry dataset has, without reading any of them. */
export async function registryTaskCount(name: string, version: string | null | undefined): Promise<number> {
  return (await registryTaskRefs(name, version)).length;
}

/** The task refs of one registry dataset. No version: the last one the registry lists. */
export async function registryTaskRefs(name: string, version: string | null | undefined): Promise<Array<{ name: string; ref: EvalTaskRef }>> {
  const all = (await loadRegistry()).filter((dataset) => dataset.name === name);
  const dataset = version ? all.find((entry) => String(entry.version) === String(version)) : all[all.length - 1];
  if (!dataset) {
    const versions = all.map((entry) => entry.version).join(', ');
    throw new EvalTrialError('TaskLoadError', all.length ? `Dataset ${name} has no version ${version}. Versions: ${versions}.` : `The Harbor registry has no dataset named ${name}.`);
  }
  return dataset.tasks.map((task) => {
    if (!task.git_url || !task.git_commit_id) {
      throw new EvalTrialError('TaskLoadError', `Dataset ${name}: task ${task.name ?? task.path} names no git repository and commit.`);
    }
    return {
      name: task.name ?? task.path.split('/').pop() ?? task.path,
      ref: { kind: 'git' as const, git_url: checkedGitUrl(task.git_url), commit: checkedCommit(task.git_commit_id), path: task.path.replace(/^\.?\/+|\/+$/g, '') },
    };
  });
}
