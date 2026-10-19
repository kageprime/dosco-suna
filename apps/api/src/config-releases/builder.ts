/**
 * Config release builder.
 *
 * A config release is one tree (its file list with blob IDs) plus one compiled
 * governance. The API-built archive of the tree is keyed by the tree ID, so
 * every commit and every variant with identical files shares one archive; a
 * tree over `MAX_CONFIG_ARCHIVE_BYTES` has none, and a v3 box builds it from
 * its checkout or the project snapshot (`snapshot.ts`). The builder reads only
 * the API's bare mirror. It never calls into a sandbox.
 *
 * The git plumbing behind `build` — tree resolution, release-tree composition,
 * archive bytes — lives in `release-tree.ts`; this module owns the release
 * orchestration (caches, governance, the store) and re-exports the plumbing's
 * public names, so every `./builder` import path keeps working.
 */

import { createHash } from 'node:crypto';
import { toolAllowed, type CompiledAgentSet } from '@kortix/api-contract/runtime-relay';
import { config } from '../config';
import { refreshMirror, runGitCapture } from '../projects/git/mirror';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from '../projects/lib/compile-agent-config';
import { buildPlatformMetaOpenCodeConfig } from '../projects/lib/platform-meta-agent';
import type { GitBackedProject } from '../projects/git/types';
import { bumpBounded } from '../shared/ttl-memo';
import { configArchiveKey, getConfigArchiveStore, type ConfigArchiveStore } from './store';
import type { ConfigReleaseFile, ConfigReleaseVariant } from './release-tree';
import {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  HEX40,
  isComposedSource,
  listConfigFiles,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  readFileTree,
  resolveReleaseTreeSource,
  toolModuleFiles,
} from './release-tree';

export {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  isComposedSource,
  isTreeObject,
  listConfigFiles,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  resolveReleaseTreeSource,
  selectedOpenCodePlugins,
} from './release-tree';
export type { ConfigReleaseVariant } from './release-tree';

/**
 * The descriptor formats. `v2` is what a daemon that sends no `accept` gets:
 * a tree release always carries the API-built archive, so a tree over
 * `MAX_CONFIG_ARCHIVE_BYTES` gets no release at all. `v3` (the daemon sends
 * `{"accept":["config-release-v3"]}`) keeps the release for such a tree:
 * `archive` is null, and the box builds the release from its own `/workspace`
 * checkout or from the project snapshot (`snapshot`). The release ID is the
 * same in both formats for every tree under the cap.
 */
export const CONFIG_RELEASE_FORMAT_V2 = 'config-release-v2';
export const CONFIG_RELEASE_FORMAT_V3 = 'config-release-v3';
export type ConfigReleaseFormat = typeof CONFIG_RELEASE_FORMAT_V2 | typeof CONFIG_RELEASE_FORMAT_V3;

/**
 * Always `follow-base`: a session runs the base branch's CURRENT config
 * release. One member on purpose — there is no per-session config policy, and
 * a session's own edits under `/workspace` reach a box only once they are
 * pushed to the base branch.
 */
type ConfigMode = 'follow-base';

/**
 * The manifest no longer declares the agent this session was created with.
 *
 * Per-SESSION, not per-release: two sessions can share one release ID and only
 * one of them be re-pointed, so this is attached by `toDescriptor` and is
 * deliberately NOT part of `ConfigRelease` (which is cached per project,
 * commit and variant) nor of `release_id`.
 *
 * LANE D / daemon: render `reason` verbatim into the session notice
 * (`config-provider/notice.ts` in kortixd, composed into OpenCode `instructions` at
 * `lifecycle.ts:399-407`). It is written as a finished sentence for the agent
 * and the user; the daemon adds no wording of its own.
 */
export interface ConfigReleaseAgentRepoint {
  /** The agent name `project_sessions.agent_name` held. */
  from: string;
  /** The project's declared default agent, or null when there was none. */
  to: string | null;
  /** True when the release is built for `to`. False ⇒ the session runs no agent. */
  applied: boolean;
  /** One finished sentence, for the session notice, `GET /config`, the web header and the CLI. */
  reason: string;
}

/**
 * The project snapshot boot object of `source_commit` (`git-proxy/project-snapshot*`):
 * the commit's working tree plus a blobless `.git`, as `tar.gz`. A v3 box
 * downloads it with no credential, keeps the files `files` lists, and verifies
 * each against its blob ID. Not cached: the URL expires.
 */
export interface ConfigReleaseSnapshot {
  url: string;
  sha256: string;
  bytes: number;
  entries: number;
  expires_at: string;
}

export interface ConfigReleaseDescriptor {
  format: ConfigReleaseFormat;
  /** `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`, hex. Null when there is no release. */
  release_id: string | null;
  mode: ConfigMode;
  source_commit: string;
  config_dir: string | null;
  config_tree_id: string | null;
  /** The API-built archive. v3: null for a tree over `MAX_CONFIG_ARCHIVE_BYTES`. */
  archive: { url: string; bytes: number } | null;
  files: ConfigReleaseFile[] | null;
  compiled_governance: string | null;
  compiled_governance_etag: string | null;
  /** Why there is no release, or null. */
  reason: string | null;
  /** Set only when the manifest dropped the session's agent. */
  agent_repoint: ConfigReleaseAgentRepoint | null;
  /** v3 only, attached per request by the descriptor route. */
  snapshot?: ConfigReleaseSnapshot | null;
}

/**
 * The session-independent part of a descriptor. Cached per
 * `(project, commit, variant)`, which is why the per-session `agent_repoint`
 * is not part of it.
 */
export type ConfigRelease = Omit<ConfigReleaseDescriptor, 'format' | 'mode' | 'agent_repoint' | 'snapshot'> & {
  /** Why a tree release has no archive (over the cap). A v2 descriptor turns it into "no release". */
  archive_reason?: string;
  /** The tree holds only project tool modules (`toolsRelease`): a session without repository access may receive it. */
  tools_only?: true;
};

class ConfigReleaseCommitNotFoundError extends Error {
  constructor(readonly commit: string) {
    super(`commit ${commit} is not in the project mirror`);
    this.name = 'ConfigReleaseCommitNotFoundError';
  }
}

/**
 * `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`,
 * hex. Null only when both are null. A session without a config archive (no
 * config dir, or no repository access) still has a release ID when it has
 * governance, so a governance-only change converges.
 */
export function configReleaseId(configTreeId: string | null, compiledGovernanceEtag: string | null): string | null;
export function configReleaseId(configTreeId: string, compiledGovernanceEtag: string | null): string;
export function configReleaseId(configTreeId: string | null, compiledGovernanceEtag: string | null): string | null {
  if (configTreeId === null && compiledGovernanceEtag === null) return null;
  return createHash('sha256')
    .update(`${configTreeId ?? ''}:${compiledGovernanceEtag ?? ''}`)
    .digest('hex');
}

/**
 * The archive's API path. A composed release tree (see `composeReleaseTree`)
 * exists in no mirror, so its path carries the commit it was composed from and
 * the route rebuilds it from there. The daemon accepts a query string.
 */
export function configArchiveRoute(projectId: string, configTreeId: string, composedFrom?: string, variant?: ConfigReleaseVariant): string {
  const path = `/v1/projects/${projectId}/config-archives/${configTreeId}`;
  return composedFrom ? `${path}?commit=${composedFrom}${variant?.startsWith('agent:') ? `&agent=${encodeURIComponent(variant.slice(6))}` : ''}` : path;
}

<<<<<<< HEAD
/** Resolve `git rev-parse <commit>:<config dir>` to a tree ID, or null. */
export async function resolveConfigTreeId(
  mirror: string,
  commit: string,
  configDir: string,
): Promise<string | null> {
  // `<commit>:<path>^{tree}` would read `^{tree}` as part of the path, so the
  // object type is checked separately.
  const result = await runGitCapture(['rev-parse', '--verify', '--quiet', `${commit}:${configDir}`], mirror);
  const tree = result.stdout.trim();
  if (result.exitCode !== 0 || !HEX40.test(tree)) return null;
  return (await isTreeObject(mirror, tree)) ? tree : null;
}

/** Is `treeId` a tree object in the mirror? */
export async function isTreeObject(mirror: string, treeId: string): Promise<boolean> {
  if (!HEX40.test(treeId)) return false;
  const result = await runGitCapture(['cat-file', '-t', treeId], mirror);
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
  const result = await runGitCapture(['ls-tree', '-r', '-z', treeId], mirror, null, env);
  if (result.exitCode !== 0) {
    throw new Error(`git ls-tree ${treeId} failed: ${result.stderr.trim()}`);
  }
  const files: ConfigReleaseFile[] = [];
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob' || !mode || !blob || !path) continue;
    files.push([path, mode, blob]);
  }
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
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
  const repo = await mkdtemp(join(tmpdir(), 'kortix-config-archive-'));
  try {
    const init = await runGitCapture(['init', '--quiet', '--bare', repo], tmpdir());
    if (init.exitCode !== 0) throw new Error(`git init scratch repo failed: ${init.stderr.trim()}`);
    await mkdir(join(repo, 'info'), { recursive: true });
    await writeFile(join(repo, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    // The mirror is bare, so this is `<mirror>/objects`; asking git also
    // covers a non-bare repository.
    const objects = await runGitCapture(['rev-parse', '--git-path', 'objects'], mirror);
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
  return withScratchRepo(mirror, (repo, env) => archiveTree(repo, env, treeId, limit));
}

async function archiveTree(
  repo: string,
  env: Record<string, string>,
  treeId: string,
  limit: number,
): Promise<Buffer> {
  const wrapped = await runGitCapture(['commit-tree', treeId, '-m', 'config'], repo, null, env);
  const commit = wrapped.stdout.trim();
  if (wrapped.exitCode !== 0 || !HEX40.test(commit)) {
    throw new Error(`git commit-tree ${treeId} failed: ${wrapped.stderr.trim()}`);
  }
  return archiveThroughGzip(repo, commit, env, limit);
}

/**
 * What a config release tree is made of at one commit.
 *
 * The OpenCode config dir, plus the skills of the root `skills/` dir (the
 * harness-neutral project layout, `@kortix/manifest-schema/layout`), plus the
 * pi config dir as `pi/`. A root skill replaces a config-dir skill of the same
 * name. Only a root entry that holds a `SKILL.md` counts, so an unrelated
 * `skills/` folder in a code repository adds nothing.
 */
export interface ReleaseTreeSource {
  configDir: string;
  /** The config dir's own tree ID in the mirror. */
  configTree: string;
  /** Root `skills/` entries, as `git ls-tree -z` records, that hold a SKILL.md. */
  rootSkills: string[];
  /** Selected plugins; null keeps the legacy, globally auto-discovered set. */
  plugins: string[] | null;
  /** The pi config dir's tree ID (`piConfigDirCandidates`), or null when the commit has none. */
  piTree: string | null;
}

/** The pi config dir's place in a release: pi reads `<release>/pi`; OpenCode ignores it. */
export const PI_RELEASE_DIR = 'pi';

/**
 * Is the release tree composed, rather than the config dir's own tree? A
 * composed tree exists in no mirror: its archive URL carries the commit, and
 * the archive route rebuilds it from there.
 */
export function isComposedSource(source: ReleaseTreeSource): boolean {
  return source.rootSkills.length > 0 || source.plugins !== null || source.piTree !== null;
}

/** `git ls-tree -z <tree>`: the tree's records, keyed by entry name. */
async function treeRecords(
  repo: string,
  treeId: string,
  env?: Record<string, string>,
): Promise<Map<string, string>> {
  const result = await runGitCapture(['ls-tree', '-z', treeId], repo, null, env);
  if (result.exitCode !== 0) throw new Error(`git ls-tree ${treeId} failed: ${result.stderr.trim()}`);
  const records = new Map<string, string>();
  for (const record of result.stdout.split('\0')) {
    if (record) records.set(record.slice(record.indexOf('\t') + 1), record);
  }
  return records;
}

/** The root `skills/` entries of `commit` that hold a SKILL.md, sorted by name. */
export async function rootSkillRecords(mirror: string, commit: string): Promise<string[]> {
  const tree = await resolveConfigTreeId(mirror, commit, SKILLS_DIR);
  if (!tree) return [];
  const listed = await runGitCapture(['ls-tree', '-r', '-z', '--name-only', tree], mirror);
  if (listed.exitCode !== 0) throw new Error(`git ls-tree ${tree} failed: ${listed.stderr.trim()}`);
  const withSkill = new Set(
    listed.stdout
      .split('\0')
      .filter((path) => path.endsWith('/SKILL.md'))
      .map((path) => path.slice(0, path.indexOf('/'))),
  );
  return [...(await treeRecords(mirror, tree)).entries()]
    .filter(([name, record]) => withSkill.has(name) && record.split(' ')[1] === 'tree')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, record]) => record);
}

/** `git mktree -z` in `repo` (never the mirror). mktree sorts the entries itself. */
async function mktree(repo: string, env: Record<string, string>, records: string[]): Promise<string> {
  const child = spawn('git', ['mktree', '-z'], {
    cwd: repo,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  child.stdin.end(records.map((record) => `${record}\0`).join(''));
  const code = await exit;
  const tree = Buffer.concat(stdout).toString('utf8').trim();
  if (code !== 0 || !HEX40.test(tree)) {
    throw new Error(`git mktree failed: ${Buffer.concat(stderr).toString('utf8').trim()}`);
  }
  return tree;
}

/**
 * The release tree ID of `source`, written into `repo` (a scratch repository
 * that reads the mirror through alternates). With no root skills and no pi
 * config dir it is the config dir's own tree, so a project on the legacy
 * layout keeps its tree ID, its release ID and its archive bytes exactly.
 */
export async function composeReleaseTree(
  repo: string,
  env: Record<string, string>,
  source: ReleaseTreeSource,
): Promise<string> {
  if (!isComposedSource(source)) return source.configTree;
  const top = await treeRecords(repo, source.configTree, env);
  if (source.rootSkills.length) {
    const skills = new Map<string, string>();
    const configSkills = top.get(SKILLS_DIR);
    if (configSkills && configSkills.split(' ')[1] === 'tree') {
      const tree = configSkills.slice(0, configSkills.indexOf('\t')).split(' ')[2]!;
      for (const [name, record] of await treeRecords(repo, tree, env)) skills.set(name, record);
    }
    for (const record of source.rootSkills) skills.set(record.slice(record.indexOf('\t') + 1), record);
    top.set(SKILLS_DIR, `040000 tree ${await mktree(repo, env, [...skills.values()])}\t${SKILLS_DIR}`);
  }
  if (source.plugins !== null) {
    const selected = new Set(source.plugins);
    const pluginTree = top.get('plugins');
    if (pluginTree) {
      const tree = pluginTree.slice(0, pluginTree.indexOf('\t')).split(' ')[2]!;
      const entries = await treeRecords(repo, tree, env);
      for (const [name, record] of entries) {
        if (/\.[cm]?[jt]s$/.test(name) && record.split(' ')[1] === 'blob' && !selected.has(name)) entries.delete(name);
      }
      if (entries.size) top.set('plugins', `040000 tree ${await mktree(repo, env, [...entries.values()])}\tplugins`);
      else top.delete('plugins');
    }
  }
  // Replaces a `pi/` folder of the OpenCode config dir, which no reader loads.
  if (source.piTree) top.set(PI_RELEASE_DIR, `040000 tree ${source.piTree}\t${PI_RELEASE_DIR}`);
  return mktree(repo, env, [...top.values()]);
}

/** The first `piConfigDirCandidates` entry that is a tree at `commit`, or null. */
export async function resolvePiConfigTree(
  mirror: string,
  commit: string,
  manifest: Record<string, unknown> | null,
): Promise<string | null> {
  for (const dir of piConfigDirCandidates(manifest)) {
    const tree = await resolveConfigTreeId(mirror, commit, dir);
    if (tree) return tree;
  }
  return null;
}

/** Compose the release tree of `source` in a scratch repository and read it there. */
export async function readComposedRelease(
  mirror: string,
  source: ReleaseTreeSource,
  options: { archive: boolean; limit?: number },
): Promise<{ treeId: string; files: ConfigReleaseFile[]; archive: Buffer | null }> {
  return withScratchRepo(mirror, async (repo, env) => {
    const treeId = await composeReleaseTree(repo, env, source);
    const files = await listConfigFiles(repo, treeId, env);
    const archive = options.archive
      ? await archiveTree(repo, env, treeId, options.limit ?? MAX_CONFIG_ARCHIVE_BYTES)
      : null;
    return { treeId, files, archive };
  });
}

/** Filename references only. The plugin implementation stays in the repository. */
export function selectedOpenCodePlugins(manifest: Record<string, unknown> | null, agent: string): string[] | null {
  if (manifest?.kortix_version !== 2) return null;
  const global = (manifest.harnesses as { opencode?: { plugins?: string[] } } | undefined)?.opencode?.plugins;
  const agents = manifest.agents as Record<string, { harnesses?: { opencode?: { plugins?: string[]; exclude?: string[] } } }> | undefined;
  const local = agents?.[agent]?.harnesses?.opencode;
  if (!agents?.[agent]) return null;
  if (!global && !local) return null;
  const excluded = new Set(local?.exclude ?? []);
  return [...new Set([...(global ?? []).filter((name) => !excluded.has(name)), ...(local?.plugins ?? [])])];
}

/**
 * The release tree source of `commit`, or a reason there is none. Shared by
 * the builder and the archive route, which rebuilds a composed tree from the
 * commit in its path.
 */
export async function resolveReleaseTreeSource(
  mirror: string,
  project: Pick<GitBackedProject, 'manifestPath'>,
  commit: string,
  variant: ConfigReleaseVariant = 'project',
): Promise<{ source: ReleaseTreeSource } | { configDir: string | null; reason: string }> {
  const manifest = await readManifestAtSha(mirror, project, commit);
  const configDir = await resolveOpencodeConfigDirAtSha(mirror, project, commit, manifest);
  if (!configDir) return { configDir: null, reason: 'the commit has no OpenCode config dir' };
  const configTree = await resolveConfigTreeId(mirror, commit, configDir);
  if (!configTree) return { configDir, reason: `config dir ${configDir} is not a tree at ${commit}` };
  const plugins = variant.startsWith('agent:') ? selectedOpenCodePlugins(manifest, variant.slice(6)) : null;
  if (plugins !== null) {
    const available = (await listConfigFiles(mirror, configTree))
      .filter(([path]) => /^plugins\/[^/]+\.[cm]?[jt]s$/.test(path))
      .map(([path]) => path.slice(8));
    const missing = plugins.filter((name) => !available.includes(name));
    if (missing.length) throw new Error(`OpenCode plugin not found in ${configDir}/plugins: ${missing.join(', ')}`);
  }
  return {
    source: {
      configDir,
      configTree,
      rootSkills: await rootSkillRecords(mirror, commit),
      plugins,
      piTree: await resolvePiConfigTree(mirror, commit, manifest),
    },
  };
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
  const archived = await runGitCapture(['archive', '--format=tar', '-o', tarPath, commit], repo, null, env);
  if (archived.exitCode !== 0) throw new Error(`git archive ${commit} failed: ${archived.stderr.trim()}`);
  if ((await stat(tarPath)).size > MAX_CONFIG_TAR_BYTES) throw new ConfigArchiveTooLargeError(limit);
  try {
    await execFileAsync('gzip', ['-n', '-f', tarPath], { timeout: 60_000 });
  } catch (error) {
    throw new Error(`gzip -n failed: ${(error as Error).message}`);
  }
  // Read once and measure the bytes read: a stat followed by a read can see
  // two different files (CodeQL js/file-system-race).
  const gz = await readFile(`${tarPath}.gz`);
  if (gz.length > limit) throw new ConfigArchiveTooLargeError(limit);
  return gz;
}

=======
>>>>>>> upstream-dev
interface CachedRelease {
  release: ConfigRelease;
  at: number;
}

const MAX_CACHED_RELEASES = 1_000;
const releases = new Map<string, CachedRelease>();
const inflight = new Map<string, Promise<ConfigRelease>>();
/** Archive byte counts per store key. The archive is deterministic per tree ID. */
const archiveBytes = new Map<string, number>();
const MAX_CACHED_ARCHIVE_SIZES = 5_000;

interface BuildConfigReleaseOptions {
  store?: ConfigArchiveStore;
  /** Tests only: skip the in-memory descriptor cache. */
  noCache?: boolean;
  /** Tests only: a smaller archive cap, so the over-limit case needs no 32 MiB fixture. */
  archiveLimit?: number;
}

/**
 * Put the archive into the store, then bound what the project keeps.
 *
 * The store is a cache: a failure is logged and the archive route streams a
 * fresh build instead. Retention rides the publish because that is the only
 * moment a project gains an archive — no cron, no worker, no leader election.
 * A prune failure is never allowed to fail a publish; the next publish retries
 * it.
 */
export async function storeConfigArchive(
  store: ConfigArchiveStore,
  projectId: string,
  key: string,
  archive: Buffer,
  options: { keep?: number } = {},
): Promise<'created' | 'exists' | 'failed'> {
  let outcome: 'created' | 'exists';
  try {
    outcome = await store.putIfAbsent(key, archive);
  } catch (error) {
    console.warn(`[config-releases] store put ${key} failed; the archive route streams from the mirror: ${(error as Error).message}`);
    return 'failed';
  }
  // 0 = the bucket's own lifecycle rule owns retention (AWS: the API task role
  // has s3:PutObject/GetObject/ListBucket and NO s3:DeleteObject by design —
  // infra/terraform/modules/ecs-api). Supabase Storage has no lifecycle engine,
  // so there the API prunes.
  const keep = options.keep ?? config.KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT;
  if (outcome === 'created' && keep > 0) {
    try {
      const deleted = await store.pruneProject(projectId, keep);
      if (deleted.length > 0) {
        console.log(`[config-releases] pruned ${deleted.length} archive(s) of project ${projectId}, keeping ${keep}`);
      }
    } catch (error) {
      console.warn(`[config-releases] prune of project ${projectId} failed: ${(error as Error).message}`);
    }
  }
  return outcome;
}

/** The `none` variant's compiled governance: a valid, empty OpenCode config. */
const EMPTY_GOVERNANCE = '{}';

async function compileGovernance(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
): Promise<string | null> {
  if (variant === 'project') return resolveCompiledAgentConfigForSession(project, commit);
  if (variant === 'none') return EMPTY_GOVERNANCE;
  if (variant === 'meta') return buildPlatformMetaOpenCodeConfig();
  return resolveSelectedAgentConfigForSession(project, variant.slice('agent:'.length), commit);
}

async function build(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  store: ConfigArchiveStore,
  archiveLimit?: number,
): Promise<ConfigRelease> {
  // A commit the mirror holds needs no fetch (`freshRef`).
  let mirror = await refreshMirror(project, false, { freshRef: commit });
  // A commit the warm mirror has not fetched yet: fetch once, then give up.
  if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
    mirror = await refreshMirror(project, true);
    if ((await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], mirror)).exitCode !== 0) {
      throw new ConfigReleaseCommitNotFoundError(commit);
    }
  }
  const base: ConfigRelease = {
    release_id: null,
    source_commit: commit,
    config_dir: null,
    config_tree_id: null,
    archive: null,
    files: null,
    compiled_governance: null,
    compiled_governance_etag: null,
    reason: null,
  };

  // Governance first: a selected-agent compile failure means no release. The
  // session keeps its running config rather than run without its agent.
  let governance: string | null;
  try {
    governance = await compileGovernance(project, commit, variant);
  } catch (error) {
    return { ...base, reason: `${COMPILED_GOVERNANCE_FAILED}: ${(error as Error).message}` };
  }
  const etag = agentConfigEtag(governance);
  const withGovernance: ConfigRelease = {
    ...base,
    compiled_governance: governance,
    compiled_governance_etag: etag,
  };

  // The meta coordinator gets a governance-only release: its box holds no
  // project checkout.
  const governanceOnly = configReleaseId(null, etag);
  if (variant === 'meta') return { ...withGovernance, release_id: governanceOnly };
  if (variant !== 'project') return toolsRelease(project, mirror, commit, variant, withGovernance, store, archiveLimit);
  let resolved: Awaited<ReturnType<typeof resolveReleaseTreeSource>>;
  try {
    resolved = await resolveReleaseTreeSource(mirror, project, commit, variant);
  } catch (error) {
    return { ...withGovernance, reason: (error as Error).message };
  }
  if (!('source' in resolved)) {
    return { ...withGovernance, release_id: governanceOnly, config_dir: resolved.configDir, reason: resolved.reason };
  }
  const { source } = resolved;
  const configDir = source.configDir;
  const composed = isComposedSource(source);

  let treeId = source.rootTree;
  let files: ConfigReleaseFile[] | null = null;
  let freshArchive: Buffer | null = null;
  try {
    if (composed) {
      // The tree is only known once composed; the archive builds in the same
      // scratch repository, on an archive-size cache miss only.
      const read = await readComposedRelease(mirror, source, {
        limit: archiveLimit,
        archive: (composedTreeId) => !archiveBytes.has(configArchiveKey(project.projectId, composedTreeId)),
      });
      treeId = read.treeId;
      files = read.files;
      freshArchive = read.archive;
    } else if (!archiveBytes.has(configArchiveKey(project.projectId, treeId))) {
      freshArchive = await buildConfigArchive(mirror, treeId, archiveLimit);
    }
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) {
      // The release exists; only the API-built archive does not. A v3 box
      // builds it from its checkout or the project snapshot. The answer is a
      // fact of the commit, so it is cached like any release: each miss tars
      // and gzips the whole tree again (~1.5 s for 36 MB).
      const read = composed ? await readComposedRelease(mirror, source, { archive: false }) : null;
      treeId = read?.treeId ?? treeId;
      return {
        ...withGovernance,
        release_id: configReleaseId(treeId, etag),
        config_dir: configDir,
        config_tree_id: treeId,
        files: read?.files ?? (await listConfigFiles(mirror, treeId)),
        archive_reason:
          `the repository at ${commit.slice(0, 12)} exceeds the ${archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES}-byte config archive limit. ` +
          'Move large static files out of Git into object storage (S3, R2, GCS), or mark paths no agent reads ' +
          '`export-ignore` in .gitattributes. `kortix validate` lists the largest files.',
      };
    }
    throw error;
  }
  const located: ConfigRelease = { ...withGovernance, config_dir: configDir, config_tree_id: treeId };

  const key = configArchiveKey(project.projectId, treeId);
  if (freshArchive) {
    await storeConfigArchive(store, project.projectId, key, freshArchive);
    bumpBounded(archiveBytes, key, freshArchive.length, MAX_CACHED_ARCHIVE_SIZES);
  }
  const bytes = archiveBytes.get(key)!;

  return {
    ...located,
    release_id: configReleaseId(treeId, etag),
    archive: { url: configArchiveRoute(project.projectId, treeId, composed ? commit : undefined, variant), bytes },
    files: files ?? (await listConfigFiles(mirror, treeId)),
  };
}

/**
 * The release of a session without repository access (`agent:<name>`, `none`):
 * the modules of the project tools its agent may call and the files they
 * import by a relative path, nothing else. A session whose agent calls no
 * project tool gets governance only.
 */
async function toolsRelease(
  project: GitBackedProject,
  mirror: string,
  commit: string,
  variant: ConfigReleaseVariant,
  withGovernance: ConfigRelease,
  store: ConfigArchiveStore,
  archiveLimit?: number,
): Promise<ConfigRelease> {
  const etag = withGovernance.compiled_governance_etag;
  const compiled = JSON.parse(withGovernance.compiled_governance ?? '{}') as Partial<CompiledAgentSet>;
  const agent = variant.startsWith('agent:') ? compiled.agent?.[variant.slice('agent:'.length)] : undefined;
  const modules = agent
    ? Object.entries(compiled.project_tools ?? {}).filter(([name]) => toolAllowed(agent.tools, name)).map(([, path]) => path)
    : [];
  const rootTree = (await runGitCapture(['rev-parse', `${commit}^{tree}`], mirror)).stdout.trim();
  const files = modules.length > 0 ? await toolModuleFiles(mirror, rootTree, modules) : [];
  if (files.length === 0) {
    return { ...withGovernance, release_id: configReleaseId(null, etag), reason: REPOSITORY_ACCESS_WITHHELD };
  }
  let read: { treeId: string; archive: Buffer | null };
  try {
    read = await readFileTree(mirror, files, {
      limit: archiveLimit,
      archive: (treeId) => !archiveBytes.has(configArchiveKey(project.projectId, treeId)),
    });
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) return { ...withGovernance, reason: `the project tool modules exceed the ${archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES}-byte config archive limit` };
    throw error;
  }
  const key = configArchiveKey(project.projectId, read.treeId);
  if (read.archive) {
    await storeConfigArchive(store, project.projectId, key, read.archive);
    bumpBounded(archiveBytes, key, read.archive.length, MAX_CACHED_ARCHIVE_SIZES);
  }
  return {
    ...withGovernance,
    tools_only: true,
    release_id: configReleaseId(read.treeId, etag),
    config_tree_id: read.treeId,
    files,
    archive: { url: configArchiveRoute(project.projectId, read.treeId, commit, variant), bytes: archiveBytes.get(key)! },
  };
}

/**
 * Build (or read from the in-memory cache) the release for one commit and one
 * variant. `commit` must be a full commit SHA the mirror already holds. The
 * caller resolves the base tip after `invalidateProjectMirror`.
 */
export async function buildConfigRelease(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
  options: BuildConfigReleaseOptions = {},
): Promise<ConfigRelease> {
  if (!HEX40.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const store = options.store ?? getConfigArchiveStore();
  if (options.noCache) return build(project, commit, variant, store, options.archiveLimit);

  const cacheKey = `${project.projectId}\0${commit}\0${variant}`;
  const cached = releases.get(cacheKey);
  if (cached) return cached.release;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const next = build(project, commit, variant, store, options.archiveLimit)
    .then((release) => {
      // A release with a reason can be transient (a compile read that failed).
      // Only complete releases are cached; an over-limit tree is one.
      if (release.release_id) {
        bumpBounded(releases, cacheKey, { release, at: Date.now() }, MAX_CACHED_RELEASES);
      }
      return release;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, next);
  return next;
}

const REPOSITORY_ACCESS_WITHHELD = 'repository access withheld';
const COMPILED_GOVERNANCE_FAILED = 'compiled governance failed';

/**
 * The wire descriptor for a release. The mode is always `follow-base`.
 *
 * A session without repository access receives only a tools-only release
 * (`toolsRelease`): the modules of the project tools its agent may call. It
 * gets no repository URL and no clone (`allowsFullRepository`), and any other
 * archive would disclose files that mode withholds. Without project tools it
 * keeps the compiled governance alone, and its release ID covers the
 * governance alone so a governance change still converges.
 *
 * A v2 descriptor of a tree over the archive cap is "no release" with the
 * reason: a v2 daemon reads `archive: null` as governance only and would run
 * the image default as if it were the release.
 */
export function toDescriptor(
  release: ConfigRelease,
  options: {
    repositoryAccess: boolean;
    agentRepoint?: ConfigReleaseAgentRepoint | null;
    format?: ConfigReleaseFormat;
  } = {
    repositoryAccess: true,
  },
): ConfigReleaseDescriptor {
  const mode: ConfigMode = 'follow-base';
  const format = options.format ?? CONFIG_RELEASE_FORMAT_V3;
  const agent_repoint = options.agentRepoint ?? null;
  const { archive_reason, tools_only, ...wire } = release;
  if (!options.repositoryAccess && !tools_only) {
    return {
      ...wire,
      format,
      mode,
      agent_repoint,
      // Governance-only release ID: a governance change still converges.
      release_id: configReleaseId(null, release.compiled_governance_etag),
      config_dir: null,
      config_tree_id: null,
      archive: null,
      files: null,
      // A governance failure is the more useful reason: it names why the
      // session gets nothing at all.
      reason: release.reason?.startsWith(COMPILED_GOVERNANCE_FAILED) ? release.reason : REPOSITORY_ACCESS_WITHHELD,
    };
  }
  if (archive_reason && format === CONFIG_RELEASE_FORMAT_V2) {
    return { ...wire, format, mode, agent_repoint, release_id: null, files: null, reason: archive_reason };
  }
  return { ...wire, format, mode, agent_repoint };
}

export function __clearConfigReleaseCachesForTests(): void {
  releases.clear();
  inflight.clear();
  archiveBytes.clear();
}
