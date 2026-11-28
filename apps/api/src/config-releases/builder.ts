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
 * archive bytes — lives in `release-tree.ts` and runs in the tree threads
 * (`tree-jobs.ts`); this module owns the release orchestration (caches,
 * governance, the store) and re-exports the plumbing's public names, so every
 * `./builder` import path keeps working.
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { toolAllowed, type CompiledAgentSet } from '@kortix/api-contract/runtime-relay';
import { childProcessEnv, config } from '../config';
import {
  ensureCommitTrees,
  ensureStoreObjects,
  ensureStoreObjectsRemembered,
  faultInFromGitError,
  refreshMirror,
  runGitCapture,
} from '../projects/git/mirror';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from '../projects/lib/compile-agent-config';
import { buildMyKortixConfig } from '../projects/lib/my-kortix-agent';
import type { GitBackedProject } from '../projects/git/types';
import { __clearOverLimitMemoForTests, isObjectFetchTooLarge, noteOverLimit, recentOverLimit } from '../shared/over-limit-memo';
import { bumpBounded } from '../shared/ttl-memo';
import { configArchiveKey, configArchiveProjectPrefix, getConfigArchiveStore, type ConfigArchiveStore } from './store';
import type { AgentFileListInput, ConfigReleaseFile, ConfigReleaseVariant } from './release-tree';
import { ConfigArchiveTooLargeError, HEX40, MAX_CONFIG_ARCHIVE_BYTES, variantAgent } from './release-tree';
import { configureReleaseTreeGit, startProcess, type ReleaseTreeObjects } from './release-tree-git';
import { TreeJobBusyError, TreeJobs, TreeJobTimeoutError } from './tree-jobs';
import type { TreeOp, TreeOpArgs, TreeOpResult } from './tree-protocol';

export {
  agentReleaseFiles,
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  isComposedSource,
  isTreeObject,
  listConfigFiles,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  resolveReleaseTreeSource,
  variantAgent,
} from './release-tree';
export type { AgentFileScope, ConfigReleaseVariant } from './release-tree';
export { TreeJobBusyError, TreeJobTimeoutError } from './tree-jobs';

/** What a tree thread asks the API process for: downloads with the project's credentials (`release-tree-git.ts`). */
const projectObjects: ReleaseTreeObjects = {
  ensureObjects: (repo, oids, options = {}) =>
    options.overLimitKey
      ? ensureStoreObjectsRemembered(repo, options.overLimitKey, oids, { maxBytes: options.maxBytes })
      : ensureStoreObjects(repo, oids, { maxBytes: options.maxBytes }),
  ensureCommitTrees,
  faultIn: faultInFromGitError,
};

// The few calls that still run in this process (`isTreeObject`, and tests) use the same git.
configureReleaseTreeGit({
  objects: projectObjects,
  run: (spec) => startProcess(spec, childProcessEnv()).result,
  scratchDir: tmpdir(),
});

/**
 * A release's tree (listings, file lists, parses, archives) is read in a tree
 * thread. Its governance compile is not: `compileGovernance` reads
 * `kortix.yaml` and its prompt files in this process, as a session start
 * does, bounded by `MAX_GOVERNANCE_PROMPT_CHARS`.
 */
export const treeJobs = new TreeJobs({ env: childProcessEnv(), objects: projectObjects });

/** A tree job that did not run now: not built, not cached, asked again at the next convergence. */
function treeJobDeferred(error: unknown): error is TreeJobBusyError | TreeJobTimeoutError {
  return error instanceof TreeJobBusyError || error instanceof TreeJobTimeoutError;
}

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
 * (`config-provider/notice.ts` in kortixd; pi adds it to the system prompt in
 * `harness/pi/runtime.ts`). It is written as a finished sentence for the agent
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
  /** An `agent:<name>` release (`agentRelease`, `exact` file list): a session without repository access may receive it. */
  tools_only?: true;
  /** Not built now (the tree threads were busy, or the build ran too long): ask again later. */
  deferred?: true;
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
  if (!composedFrom) return path;
  const agent = variant ? variantAgent(variant) : null;
  const scope = variant?.startsWith('repo-agent:') ? '&scope=repo' : '';
  return `${path}?commit=${composedFrom}${agent ? `&agent=${encodeURIComponent(agent)}${scope}` : ''}`;
}

/** The one-agent variant an archive URL's `agent` and `scope` query values name, or null. */
export function archiveQueryVariant(agent: string | null | undefined, scope: string | null | undefined): ConfigReleaseVariant | null {
  if (!agent) return null;
  return scope === 'repo' ? `repo-agent:${agent}` : `agent:${agent}`;
}

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

/** The `none` variant's compiled governance: an empty config object, which kortixd accepts. */
const EMPTY_GOVERNANCE = '{}';

/**
 * The prompt text one governance compile reads in all, in characters. Past it
 * the compile fails (`PromptFilesTooLargeError`): no release, and the session
 * keeps the config it runs. The compile, its JSON and its etag cost ~1 ms per
 * Mi characters on the API event loop (Bun 1.4.3); the largest config known
 * is ~380 KB from ~40 files (2026-10-30).
 */
const MAX_GOVERNANCE_PROMPT_CHARS = 16 * 1024 * 1024;

async function compileGovernance(
  project: GitBackedProject,
  commit: string,
  variant: ConfigReleaseVariant,
): Promise<string | null> {
  const read = { maxPromptChars: MAX_GOVERNANCE_PROMPT_CHARS };
  if (variant === 'project') return resolveCompiledAgentConfigForSession(project, commit, read);
  if (variant === 'none') return EMPTY_GOVERNANCE;
  if (variant === 'mykortix') return buildMyKortixConfig();
  return resolveSelectedAgentConfigForSession(project, variantAgent(variant)!, commit, read);
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
  if (variant === 'mykortix') return { ...withGovernance, release_id: governanceOnly };
  try {
    if (variant !== 'project') return await agentRelease(project, mirror, commit, variant, withGovernance, store, archiveLimit);
    return await projectRelease(project, mirror, commit, withGovernance, store, archiveLimit);
  } catch (error) {
    // No release ID: nothing caches it, and the next convergence asks again.
    if (treeJobDeferred(error)) return { ...withGovernance, reason: error.message, deferred: true };
    throw error;
  }
}

/** The release of every agent: the commit's whole tree, without the paths it leaves out (`resolveReleaseTreeSource`). */
async function projectRelease(
  project: GitBackedProject,
  mirror: string,
  commit: string,
  withGovernance: ConfigRelease,
  store: ConfigArchiveStore,
  archiveLimit?: number,
): Promise<ConfigRelease> {
  const etag = withGovernance.compiled_governance_etag;
  const tree = <K extends TreeOp>(op: K, args: TreeOpArgs<K>) => treeJobs.run(project.projectId, op, args);
  const at = { mirror, manifestPath: project.manifestPath, commit };
  let resolved: TreeOpResult<'resolveSource'>;
  try {
    resolved = await tree('resolveSource', at);
  } catch (error) {
    if (treeJobDeferred(error)) throw error;
    return { ...withGovernance, reason: (error as Error).message };
  }
  if (!('rootTree' in resolved)) {
    return { ...withGovernance, release_id: configReleaseId(null, etag), reason: resolved.reason };
  }
  const { composed } = resolved;

  let treeId = resolved.rootTree;
  let files: ConfigReleaseFile[] | null = null;
  let freshArchive: Buffer | null = null;
  // A project over the cap in the last 6 h is taken to be over it still while
  // its tree holds every blob of the tree that was over: an archive build
  // would download every file first, only to throw it away. A tree that
  // dropped one of them is measured again (`over-limit-memo.ts`). Listing a
  // tree reads tree objects only. A composed tree is known only once
  // composed, so it keeps the 6 h rule.
  const plainTreeBlobs =
    !composed &&
    !archiveBytes.has(configArchiveKey(project.projectId, treeId)) &&
    recentOverLimit(project.projectId, 'config-archive')
      ? (await tree('listFiles', { mirror, treeId })).map(([, , blob]) => blob)
      : undefined;
  let remembered = false;
  const archiveNeeded = (id: string) => {
    if (archiveBytes.has(configArchiveKey(project.projectId, id))) return false;
    const recent = recentOverLimit(project.projectId, 'config-archive', { blobIds: plainTreeBlobs });
    remembered = recent !== null;
    if (recent) throw new ConfigArchiveTooLargeError(archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES, recent.bytes);
    return true;
  };
  try {
    if (composed) {
      // The tree is only known once composed; the archive is built on an
      // archive-size cache miss only, from the same composition.
      const read = await tree('readComposed', { ...at, archive: false });
      treeId = read.treeId;
      files = read.files;
      if (archiveNeeded(treeId)) {
        freshArchive = (await tree('readComposed', { ...at, archive: true, limit: archiveLimit })).archive;
      }
    } else if (archiveNeeded(treeId)) {
      freshArchive = await tree('archive', { mirror, treeId, limit: archiveLimit });
    }
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) {
      // The release exists; only the API-built archive does not. A v3 box
      // builds it from its checkout or the project snapshot. The answer is a
      // fact of the commit, so it is cached like any release: each miss tars
      // and gzips the whole tree again (~1.5 s for 36 MB).
      if (composed && !files) {
        const read = await tree('readComposed', { ...at, archive: false });
        treeId = read.treeId;
        files = read.files;
      }
      const overFiles = files ?? (await tree('listFiles', { mirror, treeId }));
      // Only a measured result starts the 6 h: a remembered one must expire.
      if (!remembered) {
        noteOverLimit(project.projectId, 'config-archive', error.actualBytes ?? error.limit, {
          blobIds: overFiles.map(([, , blob]) => blob),
        });
      }
      return {
        ...withGovernance,
        release_id: configReleaseId(treeId, etag),
        config_tree_id: treeId,
        files: overFiles,
        archive_reason:
          `the repository at ${commit.slice(0, 12)} exceeds the ${archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES}-byte config archive limit. ` +
          'Move large static files out of Git into object storage (S3, R2, GCS), or mark paths no agent reads ' +
          '`export-ignore` in .gitattributes. `kortix validate` lists the largest files.',
      };
    }
    throw error;
  }
  const located: ConfigRelease = { ...withGovernance, config_tree_id: treeId };

  const key = configArchiveKey(project.projectId, treeId);
  if (freshArchive) {
    await storeConfigArchive(store, project.projectId, key, freshArchive);
    bumpBounded(archiveBytes, key, freshArchive.length, MAX_CACHED_ARCHIVE_SIZES);
  }
  const bytes = archiveBytes.get(key)!;

  return {
    ...located,
    release_id: configReleaseId(treeId, etag),
    archive: { url: configArchiveRoute(project.projectId, treeId, composed ? commit : undefined, 'project'), bytes },
    files: files ?? (await tree('listFiles', { mirror, treeId })),
  };
}

/**
 * May an agent with this compiled `permission` see the skill `name`? The
 * compiler writes `permission.skill` as `allow`, `deny`, or a map of `*` and
 * exact names (`skillsRule`); only a `deny` hides a skill, as on the box.
 */
export function compiledSkillGranted(permission: unknown, name: string): boolean {
  if (typeof permission === 'string') return permission !== 'deny';
  if (!permission || typeof permission !== 'object') return true;
  const rule = (permission as Record<string, unknown>).skill;
  if (rule === undefined) return true;
  if (typeof rule === 'string') return rule !== 'deny';
  if (!rule || typeof rule !== 'object') return true;
  const map = rule as Record<string, unknown>;
  const action = Object.hasOwn(map, name) ? map[name] : map['*'];
  return action !== 'deny';
}

/** The folders of the registered skills that any enabled agent of the compiled set is granted. */
function grantedSkillFolders(compiled: Partial<CompiledAgentSet>): string[] {
  const agents = enabledAgents(compiled);
  return Object.entries(compiled.skills ?? {})
    .filter(([name]) => agents.some((agent) => compiledSkillGranted(agent.permission, name)))
    .map(([, folder]) => folder);
}

/** The enabled agents of a compiled set: the selected agent and the subagents it may start. */
function enabledAgents(compiled: Partial<CompiledAgentSet>) {
  return Object.values(compiled.agent ?? {}).filter((agent): agent is NonNullable<typeof agent> => !!agent && !agent.disable);
}

/** The modules of the project tools any enabled agent of the set may call. */
function grantedToolModules(compiled: Partial<CompiledAgentSet>): string[] {
  const agents = enabledAgents(compiled);
  return Object.entries(compiled.project_tools ?? {})
    .filter(([name]) => agents.some((agent) => toolAllowed(agent.tools, name)))
    .map(([, path]) => path);
}

/** The repository sources of the local pi packages the set enables (`./x` or `x`); an npm package is not a repository file. */
function localPackageSources(compiled: Partial<CompiledAgentSet>): string[] {
  return Object.values(compiled.extensions ?? {}).flatMap((extension) => {
    const source = typeof extension?.pi === 'string' ? extension.pi : extension?.pi?.source;
    return typeof source === 'string' && source && !source.startsWith('npm:') ? [source] : [];
  });
}

/** The root files pi reads from any release: `AGENTS.md`, else `CLAUDE.md` (`harness/pi/config.ts`). */
const AGENT_ROOT_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * The release of one agent: `agent:<name>` for a session without repository
 * access (`exact` file list), `repo-agent:<name>` for a session with it
 * (`folders` file list, not yet assigned). `agentReleaseFiles` decides the
 * files from what the compiled set names: the tools and skills any enabled
 * agent of the set may use, the local pi packages it enables, and the root
 * `AGENTS.md` / `CLAUDE.md`. `repo-agent` adds the root manifest: the box
 * reads `sandbox.on_boot` from it (`lib/config/config.ts`). A path the
 * repository marks `export-ignore` is left out, as in the whole-tree release.
 * `none` is governance only: a session with no usable agent receives no file.
 */
async function agentRelease(
  project: GitBackedProject,
  mirror: string,
  commit: string,
  variant: ConfigReleaseVariant,
  withGovernance: ConfigRelease,
  store: ConfigArchiveStore,
  archiveLimit?: number,
): Promise<ConfigRelease> {
  const etag = withGovernance.compiled_governance_etag;
  const repository = variant.startsWith('repo-agent:');
  const governanceOnly = { ...withGovernance, release_id: configReleaseId(null, etag), reason: repository ? null : REPOSITORY_ACCESS_WITHHELD };
  if (variant === 'none') return governanceOnly;
  const tooLarge = { ...withGovernance, reason: `the files of the agent exceed the ${archiveLimit ?? MAX_CONFIG_ARCHIVE_BYTES}-byte config archive limit` };
  let files: ConfigReleaseFile[];
  let treeId: string;
  let archive: Buffer | null = null;
  try {
    // One job: the thread lists the files, writes their tree, and builds the
    // archive on an archive-size cache miss only. No file list goes to it.
    const built = await treeJobs.run(project.projectId, 'agentTree', {
      mirror,
      manifestPath: project.manifestPath,
      commit,
      input: agentFileInput(withGovernance.compiled_governance, variant, project.manifestPath),
      knownTrees: knownArchiveTrees(project.projectId),
      limit: archiveLimit,
    });
    if (!('files' in built)) return { ...withGovernance, reason: built.reason };
    if (!built.treeId) return governanceOnly;
    files = built.files;
    treeId = built.treeId;
    archive = built.archive;
  } catch (error) {
    // The modules it parses did not fit the default download bound, the list
    // passed a bound of `agentReleaseFiles`, or the archive is over the cap.
    if (isObjectFetchTooLarge(error) || error instanceof ConfigArchiveTooLargeError) return tooLarge;
    throw error;
  }
  const key = configArchiveKey(project.projectId, treeId);
  if (archive) {
    await storeConfigArchive(store, project.projectId, key, archive);
    bumpBounded(archiveBytes, key, archive.length, MAX_CACHED_ARCHIVE_SIZES);
  }
  return {
    ...withGovernance,
    ...(repository ? {} : { tools_only: true as const }),
    release_id: configReleaseId(treeId, etag),
    config_tree_id: treeId,
    files,
    archive: { url: configArchiveRoute(project.projectId, treeId, commit, variant), bytes: archiveBytes.get(key)! },
  };
}

/** What `agentReleaseFiles` starts from for a one-agent variant: what its compiled set names. */
function agentFileInput(compiledGovernance: string | null, variant: ConfigReleaseVariant, manifestPath: string): AgentFileListInput {
  const compiled = JSON.parse(compiledGovernance ?? '{}') as Partial<CompiledAgentSet>;
  const repository = variant.startsWith('repo-agent:');
  return {
    toolModules: grantedToolModules(compiled),
    skillFolders: grantedSkillFolders(compiled),
    packageSources: localPackageSources(compiled),
    rootFiles: repository ? [...AGENT_ROOT_FILES, manifestPath] : AGENT_ROOT_FILES,
    scope: repository ? 'folders' : 'exact',
  };
}

/** The trees of `projectId` whose archive this process already stored: their size is cached. */
function knownArchiveTrees(projectId: string): string[] {
  const prefix = configArchiveProjectPrefix(projectId);
  const trees: string[] = [];
  for (const key of archiveBytes.keys()) {
    if (key.startsWith(prefix)) trees.push(key.slice(prefix.length, -'.tar.gz'.length));
  }
  return trees;
}

/**
 * The archive builder of the one-agent release of `variant` at `commit`, when
 * that release's tree is `treeId`; else null. For the archive route: the tree
 * exists in no mirror, so the thread lists the agent's files again and builds
 * it. Throws `TreeJobBusyError` when the release could not be built now.
 */
export async function agentArchiveBuilder(
  project: GitBackedProject,
  mirror: string,
  commit: string,
  variant: ConfigReleaseVariant,
  treeId: string,
): Promise<(() => Promise<Buffer>) | null> {
  const release = await buildConfigRelease(project, commit, variant).catch(() => null);
  if (release?.deferred) throw new TreeJobBusyError(project.projectId);
  if (!release || release.config_tree_id !== treeId) return null;
  const input = agentFileInput(release.compiled_governance, variant, project.manifestPath);
  return async () => {
    const built = await treeJobs.run(project.projectId, 'agentTree', { mirror, manifestPath: project.manifestPath, commit, input, knownTrees: [] });
    if (!('files' in built) || built.treeId !== treeId || !built.archive) throw new Error(`the release of ${variant} at ${commit} no longer makes tree ${treeId}`);
    return built.archive;
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
 * A session without repository access receives only an `agent:<name>`
 * release (`agentRelease`, `exact` file list): the files its agent uses and
 * nothing beside them. It gets no repository URL and no clone
 * (`allowsFullRepository`), and any other archive would disclose files that
 * mode withholds. With no such file it keeps the compiled governance alone,
 * and its release ID covers the governance alone so a governance change
 * still converges. A release that was not built (no release ID) stays no
 * release: the session keeps the config it runs.
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
  const { archive_reason, tools_only, deferred, ...wire } = release;
  if (!options.repositoryAccess && !tools_only && !release.release_id) {
    // Not built (the tree threads were busy, the agent's files are over the
    // cap, a read failed): no release, not a governance-only one. A null ID
    // keeps every box on the config it runs, and nothing records it.
    return {
      ...wire,
      format,
      mode,
      agent_repoint,
      release_id: null,
      config_dir: null,
      config_tree_id: null,
      archive: null,
      files: null,
    };
  }
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
  __clearOverLimitMemoForTests();
}
