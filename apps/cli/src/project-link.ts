import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { activeHostName, defaultProject, getHost, markerActive } from './api/config.ts';
import { sandboxEnvValue } from './api/sandbox-env.ts';

/**
 * The binding between a local checkout and a Kortix workspace: which
 * workspace, on which host, the CLI uses in this folder when no
 * `--workspace` is given. `kortix ship`, `kortix workspaces link` and
 * `kortix workspaces clone` write it.
 *
 * It lives in the checkout's own git config (the `[kortix]` section of
 * `.git/config`), never in a file of the working tree: git never commits it,
 * so a workspace repository holds no CLI state. Any folder inside the
 * checkout resolves it, as git config does.
 *
 * Older CLIs wrote `.kortix/link.json` into the folder, and `kortix ship`
 * committed it. That file is still read when the git config holds no binding,
 * and {@link saveLink} / {@link migrateLegacyLink} move it into the git config
 * and delete it.
 */
export interface ProjectLink {
  project_id: string;
  account_id: string;
  /** Named host (from ~/.config/kortix/config.json) this project lives on. */
  host?: string;
  /** Snapshot of the host's URL at link time. Informational. */
  host_url?: string;
  linked_at: string;
}

/** The git config keys of the binding, in the `[kortix]` section. */
const LINK_KEYS = {
  project_id: 'kortix.workspace',
  account_id: 'kortix.account',
  host: 'kortix.host',
  host_url: 'kortix.host-url',
  linked_at: 'kortix.linked-at',
} as const satisfies Record<keyof ProjectLink, string>;

/** Where the CLI keeps the binding, for messages: `git config kortix.workspace`. */
export const LINK_LOCATION = `this checkout's git config (${LINK_KEYS.project_id})`;

/** The file older CLIs wrote. Read as a fallback, never written. */
export function legacyLinkFilePath(cwd = process.cwd()): string {
  return resolve(cwd, '.kortix', 'link.json');
}

/** Is the cwd a Kortix workspace folder? It has a manifest (`kortix.yaml` or
 *  `kortix.yml`) at its root. A bare `.kortix/` folder is the layout older
 *  CLIs wrote and does not count. */
export function isKortixProject(cwd = process.cwd()): boolean {
  return existsSync(resolve(cwd, 'kortix.yaml')) || existsSync(resolve(cwd, 'kortix.yml'));
}

function git(cwd: string, args: string[]): { ok: boolean; status: number | null; stdout: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '' };
}

/** Is the folder inside a git checkout? The link needs one. */
export function isGitCheckout(cwd = process.cwd()): boolean {
  return git(resolve(cwd), ['rev-parse', '--is-inside-work-tree']).ok;
}

/** Per process, per folder: commands resolve the link several times. A write
 *  clears it all: every folder of the checkout (and its symlinked paths) reads it. */
const gitLinkCache = new Map<string, ProjectLink | null>();

function loadGitLink(cwd: string): ProjectLink | null {
  const key = resolve(cwd);
  if (gitLinkCache.has(key)) return gitLinkCache.get(key) ?? null;
  // Exit 1: no [kortix] keys. Exit 128: not inside a git checkout.
  const out = git(key, ['config', '--local', '--get-regexp', '^kortix\\.']);
  const values = new Map<string, string>();
  if (out.ok) {
    for (const line of out.stdout.split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0) values.set(line.slice(0, space), line.slice(space + 1).trim());
    }
  }
  const projectId = values.get(LINK_KEYS.project_id);
  const link: ProjectLink | null = projectId
    ? {
        project_id: projectId,
        account_id: values.get(LINK_KEYS.account_id) ?? '',
        host: values.get(LINK_KEYS.host) || undefined,
        host_url: values.get(LINK_KEYS.host_url) || undefined,
        linked_at: values.get(LINK_KEYS.linked_at) ?? new Date().toISOString(),
      }
    : null;
  gitLinkCache.set(key, link);
  return link;
}

function loadLegacyLink(cwd: string): ProjectLink | null {
  const path = legacyLinkFilePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectLink>;
    if (typeof parsed.project_id !== 'string' || !parsed.project_id) return null;
    return {
      project_id: parsed.project_id,
      account_id: parsed.account_id ?? '',
      host: typeof parsed.host === 'string' && parsed.host ? parsed.host : undefined,
      host_url:
        typeof parsed.host_url === 'string' && parsed.host_url ? parsed.host_url : undefined,
      linked_at: parsed.linked_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** The folder's binding: the checkout's git config, else an older CLI's `.kortix/link.json`. */
export function loadLink(cwd = process.cwd()): ProjectLink | null {
  return loadGitLink(cwd) ?? loadLegacyLink(cwd);
}

/** Thrown by {@link saveLink} outside a git checkout: the binding lives in git config. */
export class NotAGitCheckoutError extends Error {
  constructor(cwd: string) {
    super(`${cwd} is not inside a git checkout. Run git init (kortix init does it) and retry.`);
    this.name = 'NotAGitCheckoutError';
  }
}

/** Delete an older CLI's `.kortix/link.json`, and `.kortix/` when it is left empty. */
function removeLegacyLink(cwd: string): boolean {
  const path = legacyLinkFilePath(cwd);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  const dir = resolve(cwd, '.kortix');
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Already gone, or not ours to remove.
  }
  return true;
}

/** Bind the checkout to a workspace: write the `[kortix]` git config keys and
 *  delete an older CLI's `.kortix/link.json`. Throws {@link NotAGitCheckoutError}
 *  outside a git checkout. `keepLegacyFile` leaves that file alone: a fresh
 *  clone of a repository that committed it stays clean, and the next
 *  `kortix ship` deletes it in its own commit. */
export function saveLink(
  link: ProjectLink,
  cwd = process.cwd(),
  opts: { keepLegacyFile?: boolean } = {},
): void {
  const key = resolve(cwd);
  if (!git(key, ['rev-parse', '--is-inside-work-tree']).ok) throw new NotAGitCheckoutError(key);
  // A rebind drops every old key first, so no stale host or account survives.
  git(key, ['config', '--local', '--remove-section', 'kortix']);
  for (const [field, name] of Object.entries(LINK_KEYS) as Array<[keyof ProjectLink, string]>) {
    const value = link[field];
    if (value) git(key, ['config', '--local', name, value]);
  }
  gitLinkCache.clear();
  if (!opts.keepLegacyFile) removeLegacyLink(key);
}

/** Remove the binding: the `[kortix]` git config keys and an older `.kortix/link.json`. */
export function clearLink(cwd = process.cwd()): void {
  const key = resolve(cwd);
  gitLinkCache.clear();
  git(key, ['config', '--local', '--remove-section', 'kortix']);
  gitLinkCache.clear();
  removeLegacyLink(key);
}

/**
 * Move an older CLI's `.kortix/link.json` into the git config and delete it.
 * Returns true when it moved one. When the git config already holds a binding,
 * the file is only deleted: the git config wins.
 */
export function migrateLegacyLink(cwd = process.cwd()): boolean {
  const legacy = loadLegacyLink(cwd);
  if (!legacy || !git(resolve(cwd), ['rev-parse', '--is-inside-work-tree']).ok) return false;
  if (loadGitLink(cwd)) return removeLegacyLink(resolve(cwd));
  saveLink(legacy, cwd);
  return true;
}

/**
 * The workspace id the environment names: `KORTIX_WORKSPACE_ID` first, then
 * `KORTIX_PROJECT_ID` (the platform-injected name inside a sandbox, and the
 * env contract every older script sets). The workspace id IS the project id.
 * The platform never injects `KORTIX_WORKSPACE_ID`: only a person or a script
 * sets it, so it never outranks a script's own `KORTIX_PROJECT_ID=<other>`.
 */
export function envWorkspaceId(): string | undefined {
  return process.env.KORTIX_WORKSPACE_ID?.trim() || sandboxEnvValue('KORTIX_PROJECT_ID') || undefined;
}

/**
 * Resolve which project a CLI command should operate on, in order:
 *   1. --workspace / --project / projectArg
 *   2. KORTIX_WORKSPACE_ID, then KORTIX_PROJECT_ID env (platform-injected inside a sandbox)
 *   3. the checkout's link (git config `kortix.workspace`, else an older `.kortix/link.json`)
 *   4. the active host's global default project (`kortix projects use`)
 * Returns null if none of those are set.
 *
 * An explicit `hostArg` uses only that named host's link or default.
 *
 * `hostScoped` marks callers that pair the result with the stored active
 * host's credential (no `--host` given): when an explicit in-sandbox
 * `hosts use` selection owns plain resolution (markerActive, KRTX-1705), the
 * AMBIENT chain — the injected KORTIX_PROJECT_ID and a link bound to another
 * host, both foreign to this credential — must not pair with it, so the
 * selected host's default project takes over, exactly as an explicit
 * `--host` resolves. A link bound to the SELECTED host itself stays the most
 * specific binding for that credential and wins, the same precedence
 * resolveProjectContext applies. The connector data plane (pinned to the
 * injected identity) must keep the ambient chain and omits the flag.
 *
 * `hostArg` (an explicit `--host`) scopes the same way (KRTX-1936): the
 * named host owns the chain — a link bound to it, else its stored default —
 * and the ambient ids (the injected KORTIX_PROJECT_ID, another host's
 * default) must not leak into it: they live on the caller's own host and
 * only 404 against the named host's credential, the same scoping
 * resolveProjectContext applies to `--host`. */
export function resolveProjectId(
  projectArg?: string,
  opts?: { hostScoped?: boolean; hostArg?: string },
): string | null {
  if (projectArg) return projectArg;
  if (opts?.hostArg || (opts?.hostScoped && markerActive())) {
    const hostName = opts.hostArg ?? activeHostName();
    const link = loadLink();
    if (link?.host && link.host === hostName && link.project_id) return link.project_id;
    return (
      (opts.hostArg ? getHost(opts.hostArg)?.default_project : defaultProject())?.project_id ?? null
    );
  }
  const envProjectId = envWorkspaceId();
  if (envProjectId) return envProjectId;
  const link = loadLink();
  if (link?.project_id) return link.project_id;
  return defaultProject()?.project_id ?? null;
}

/** Where a resolved project came from. `link` and `default` are the CLI
 *  config's own principal (a logged-in host and its project); `env` is the
 *  platform-injected sandbox pair. The two must never be mixed — see the
 *  one-principal guard in resolveProjectContext. */
export type ProjectSource = 'flag' | 'env' | 'link' | 'default';

export interface ProjectRef {
  projectId: string;
  source: ProjectSource;
}

/**
 * resolveProjectContext's project resolution, with the winning source
 * attached: --workspace/--project → the checkout's link → KORTIX_WORKSPACE_ID →
 * KORTIX_PROJECT_ID → the active host's default. The directory link is the most specific binding, so it outranks
 * the session env for every caller of this path.
 *
 * When the link names the env project itself, the env source is kept: the
 * ambient session token is a valid credential for its own project, so an
 * in-sandbox `kortix ship` (which links the session's own project) keeps
 * working without stored credentials for the link host.
 */
export function resolveProjectRef(projectArg?: string): ProjectRef | null {
  if (projectArg) return { projectId: projectArg, source: 'flag' };
  const link = loadLink();
  const envProjectId = envWorkspaceId();
  const env: ProjectRef | null = envProjectId ? { projectId: envProjectId, source: 'env' } : null;
  if (link?.project_id) {
    if (env && link.project_id === env.projectId) return env;
    return { projectId: link.project_id, source: 'link' };
  }
  const defaultRef = defaultProject();
  return (
    env ?? (defaultRef?.project_id ? { projectId: defaultRef.project_id, source: 'default' } : null)
  );
}
