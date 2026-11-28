/**
 * /workspace on a Platinum volume: the storage half of stateless sandboxes,
 * the default for every new Platinum session since 2026-11-23 (the
 * `workspace_volume` project flag graduated; a stored override is inert).
 *
 * One volume per session, `kws-<session_id>`, mounted at /workspace when the box
 * is created, so the mount exists before kortixd starts. kortixd never fills it
 * from the repository: it holds what the agent writes, including a checkout the
 * agent made with `kortix workspaces clone` (KORTIX_WORKSPACE_VOLUME=1). The box is disposable: one stopped for
 * KORTIX_SANDBOX_IDLE_DELETE_MINUTES is removed (reaping/idle-volume-retire.ts)
 * and the next open boots a fresh box on the same volume. The conversation
 * comes back from the session log (projects/lib/session-sandbox-env-build.ts).
 *
 * The decision is made once, at POST /sessions (`startWorkspaceVolume`). The
 * session row is inserted with the record `metadata.workspace_volume`, and from
 * then on only the record decides: every box of the session mounts the volume,
 * whatever the kill switch says later. My Kortix sessions get no volume
 * (projects/lib/session-create.ts).
 *
 * Platinum volumes belong to the control plane that created them: a us-east
 * volume is invisible to the global origin, which answers 404 for it, and 204
 * for a `missing_ok` delete that deletes nothing (measured on dev, 2026-10-16).
 * So the record names the region, and every call about the volume and every
 * box of the session goes to that region.
 *
 * Workspace cache (project flag `platinum_cache`): the session's volume starts
 * as a copy of the project's newest saved workspace instead of empty. It is a
 * Platinum volume cache entry (namespace `proj:<project_id>:ws`, keys `ws-…`),
 * restored by a copy-on-write fork in about a second whatever its size. The
 * record keeps `cache: { namespace }`, the box gets KORTIX_WORKSPACE_CACHE and
 * the pnpm store at /workspace/.pnpm-store (so a cached node_modules links to
 * the store it came with), and a project admin saves a prepared session's
 * volume as a new entry (saveWorkspaceCache). A restore that fails for any
 * reason opens an empty volume instead: the cache never fails a session.
 *
 * The volume lives as long as the session's content: a deleted session keeps
 * it through the trash window, and the retention purge deletes it with the
 * session's files (session-log-purge.ts), as does account erasure
 * (billing/services/account-erasure-stores.ts).
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../../config';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { platinumJson, platinumRateLimitWaitMs, platinumRegionControlPlane } from '../../shared/platinum';
import type { CreateSandboxOpts } from '../providers/contract';
import { WORKSPACE_VOLUME_UNREACHABLE_MESSAGE } from './sandbox-provisioning-error';

export const WORKSPACE_VOLUME_MOUNT = '/workspace';
/** Tells kortixd /workspace is a volume (never cleared, reported on /kortix/health). */
export const WORKSPACE_VOLUME_ENV = 'KORTIX_WORKSPACE_VOLUME';
/** project_sessions.metadata: the session's volume. Written by the session insert, never changed. Server-managed. */
export const WORKSPACE_VOLUME_SESSION_KEY = 'workspace_volume';

export interface WorkspaceVolume {
  name: string;
  /** The Platinum region it lives in, as `location` on a create; null = the home region. */
  location: string | null;
  /** The Platinum cache namespace the volume was restored from (flag `platinum_cache`), recorded at create. */
  cache?: { namespace: string };
}

/** Tells the box /workspace started from the project's workspace cache: the namespace. */
export const WORKSPACE_CACHE_ENV = 'KORTIX_WORKSPACE_CACHE';
/** The pnpm store of a cached workspace: inside /workspace, so node_modules hard-links to it and the cache carries it. */
export const WORKSPACE_CACHE_PNPM_STORE = '/workspace/.pnpm-store';
/** Every workspace cache key starts with this; a restore takes the newest one. */
export const WORKSPACE_CACHE_KEY_PREFIX = 'ws-';
/**
 * Entries a project keeps: the newest, which every restore takes, and the one before it. Measured on
 * CompanyOS (2026-11-26): a 14-day-old workspace still installs in 8.3 s against 2.3 s fresh and 42-55 s
 * with no cache, so an older entry is worth keeping and a third is not worth the budget.
 */
export const WORKSPACE_CACHE_MAX_ENTRIES = 2;
/** Idle lifetime of an entry: a project that stops starting sessions stops paying for its cache after a week. */
export const WORKSPACE_CACHE_TTL_SECONDS = 7 * 24 * 3600;
/** Platinum's cache key rule, narrowed to the `ws-` keys a project saves. */
const WORKSPACE_CACHE_KEY = /^ws-[A-Za-z0-9._:+=-]{1,120}$/;
/** Platinum's namespace rule. */
const CACHE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** The one cache namespace of a project's workspaces. A namespace is not a security boundary inside the Platinum org: only the API names it. */
export function workspaceCacheNamespace(projectId: string): string {
  return `proj:${projectId}:ws`;
}

export function isWorkspaceCacheKey(key: unknown): key is string {
  return typeof key === 'string' && WORKSPACE_CACHE_KEY.test(key);
}

const REGION_KEY = /^[a-z]{2,8}-[a-z]{2,12}$/;
/** An open that POST /sessions started and no session row recorded by then is deleted. */
const UNRECORDED_OPEN_TTL_MS = 120_000;

/**
 * Whether a new session gets a /workspace volume: Platinum is configured and
 * the deployment did not turn the kill switch on. KORTIX_WORKSPACE_VOLUMES
 * `off` (or 0/false/no) gives no new session a volume; unset, `on` or anything
 * else gives every new Platinum session one.
 */
export function workspaceVolumesEnabled(): boolean {
  if (!config.PLATINUM_API_KEY) return false;
  return !/^(0|off|false|no)$/.test((config.KORTIX_WORKSPACE_VOLUMES ?? '').trim().toLowerCase());
}

export function workspaceVolumeName(sessionId: string): string {
  return `kws-${sessionId}`;
}

/** The session's recorded volume, when the record names its own volume and a valid region. */
export function recordedWorkspaceVolume(sessionId: string, metadata: unknown): WorkspaceVolume | null {
  const v = (metadata as Record<string, unknown> | null | undefined)?.[WORKSPACE_VOLUME_SESSION_KEY] as
    | { name?: unknown; location?: unknown }
    | undefined;
  if (!v || v.name !== workspaceVolumeName(sessionId)) return null;
  const location = v.location ?? null;
  if (location !== null && !(typeof location === 'string' && REGION_KEY.test(location))) return null;
  const namespace = (v as { cache?: { namespace?: unknown } }).cache?.namespace;
  return typeof namespace === 'string' && CACHE_NAMESPACE.test(namespace)
    ? { name: v.name, location, cache: { namespace } }
    : { name: v.name, location };
}

/** The control plane that owns the volume: the region's own, or the global origin for home. */
function volumeOrigin(volume: WorkspaceVolume): string | undefined {
  if (!volume.location) return undefined;
  const origin = platinumRegionControlPlane(volume.location);
  if (!origin) throw new Error(`[workspace] No Platinum control plane is known for region ${volume.location}.`);
  return origin;
}

// replica-local: opens POST /sessions started, read once by the same process's
// provisioning (resolveWorkspaceVolume), dropped after UNRECORDED_OPEN_TTL_MS.
// ponytail: an API restart inside that window leaves an unrecorded volume behind;
// add a `kws-*` orphan sweep if Platinum's volume list shows any.
const earlyOpens = new Map<string, Promise<void>>();

/**
 * The create-time decision: the volume a new session gets, or null. It also
 * starts opening the volume, so the open runs alongside the rest of POST
 * /sessions instead of before the box create. The caller records the result
 * in the session row it inserts.
 */
export function startWorkspaceVolume(input: {
  sessionId: string;
  /** Where the session's boxes run (the project's `us_region`); undefined = home. */
  location: string | undefined;
  /** The project's workspace cache namespace when its `platinum_cache` flag is on: the volume starts from it. */
  cacheNamespace?: string;
}): WorkspaceVolume | null {
  const { sessionId } = input;
  if (!workspaceVolumesEnabled()) return null;
  const volume: WorkspaceVolume = { name: workspaceVolumeName(sessionId), location: input.location ?? null };
  if (input.cacheNamespace) volume.cache = { namespace: input.cacheNamespace };
  const open = volume.cache ? restoreWorkspaceVolume(sessionId, volume) : openWorkspaceVolume(sessionId, volume);
  open.catch(() => {});
  earlyOpens.set(sessionId, open);
  setTimeout(() => {
    if (earlyOpens.delete(sessionId)) void dropUnrecordedVolume(sessionId, volume);
  }, UNRECORDED_OPEN_TTL_MS).unref?.();
  return volume;
}

/** The create failed after the open started, or the session runs off Platinum: nothing else would delete this volume. */
async function dropUnrecordedVolume(sessionId: string, volume: WorkspaceVolume): Promise<void> {
  try {
    if (await sessionWorkspaceVolume(sessionId)) return;
    await deleteWorkspaceVolume(volume);
    logger.info(`[workspace] deleted unrecorded volume ${volume.name}`, { sessionId, region: volume.location ?? 'home' });
  } catch (err) {
    logger.warn(`[workspace] unrecorded volume ${volume.name} was not deleted`, {
      sessionId,
      region: volume.location ?? 'home',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sessionWorkspaceVolume(sessionId: string): Promise<WorkspaceVolume | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return recordedWorkspaceVolume(sessionId, row?.metadata);
}

/**
 * The opened volume a new box of this session mounts at /workspace, or null
 * for a box-disk session. Only the record decides. Fails the boot when the
 * volume cannot be opened: a session never falls back to the box disk, which
 * would not have its files.
 */
export async function resolveWorkspaceVolume(sessionId: string): Promise<WorkspaceVolume | null> {
  const volume = await sessionWorkspaceVolume(sessionId);
  if (!volume) return null;
  const early = earlyOpens.get(sessionId);
  earlyOpens.delete(sessionId);
  await (early ? early.catch(() => openWorkspaceVolume(sessionId, volume)) : openWorkspaceVolume(sessionId, volume));
  return volume;
}

/**
 * The box create for a session with a volume: a private mount at /workspace
 * (one writer), no whole-box backup (the state is on the volume), the volume's
 * region with no home-region fallback (the box could not mount it there),
 * KORTIX_WORKSPACE_VOLUME=1 for kortixd, and no one-time branch restore: that
 * restore clears a checkout whose adoption marker does not match, and on a
 * volume the checkout is the session's only copy (kortixd refuses it too).
 */
export function applyWorkspaceVolume(create: CreateSandboxOpts, volume: WorkspaceVolume): void {
  create.volumes = { ...create.volumes, [WORKSPACE_VOLUME_MOUNT]: { volume: volume.name, share: 'private' } };
  create.volumesRequired = true;
  create.location = volume.location ?? undefined;
  if (volume.location) create.locationRequired = true;
  const { KORTIX_SESSION_BRANCH_RESTORE: _restore, ...env } = create.envVars ?? {};
  create.envVars = { ...env, [WORKSPACE_VOLUME_ENV]: '1' };
  if (volume.cache) {
    // pnpm reads npm_config_* from the environment: this store wins over the image's /usr/local/etc/npmrc.
    create.envVars[WORKSPACE_CACHE_ENV] = volume.cache.namespace;
    create.envVars.npm_config_store_dir = WORKSPACE_CACHE_PNPM_STORE;
  }
}

/**
 * The create-time open of a cached session's volume: a fork of the newest
 * `ws-` entry of its namespace, or an empty block volume when there is none
 * (Platinum answers `hit: "miss"`). Any failure, a 404 for an org without
 * caches included, opens the volume the ordinary way. Never throws more than
 * that open does.
 */
async function restoreWorkspaceVolume(sessionId: string, volume: WorkspaceVolume): Promise<void> {
  const started = Date.now();
  try {
    const body = await platinumJson<{ hit?: string; entry?: { key?: string } | null }>(
      '/v1/caches/restore',
      {
        method: 'POST',
        body: JSON.stringify({
          namespace: volume.cache?.namespace,
          restore_keys: [WORKSPACE_CACHE_KEY_PREFIX],
          name: volume.name,
          sync_mode: 'git',
        }),
        signal: AbortSignal.timeout(15_000),
      },
      volumeOrigin(volume),
    );
    logger.info(`[workspace] volume ${volume.name} restored from the workspace cache`, {
      sessionId,
      region: volume.location ?? 'home',
      hit: body.hit ?? 'unknown',
      key: body.entry?.key ?? null,
      ms: Date.now() - started,
    });
    return;
  } catch (err) {
    logger.warn(`[workspace] workspace cache restore of ${volume.name} failed; opening it empty`, {
      sessionId,
      region: volume.location ?? 'home',
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    });
  }
  // A restore that created the volume before failing leaves it for this open-or-create to open.
  await openWorkspaceVolume(sessionId, volume);
}

/** A 5xx or a network failure: three tries over ~6 s. */
const OPEN_TRIES = 3;
/** A 429 (Platinum's org write budget): wait what Platinum asks, at most this many times (≤ 20 s). */
const OPEN_RATE_LIMIT_WAITS = 4;

/**
 * Open-or-create in its region, `git` sync (a single-writer working copy). A 429
 * is waited out as Platinum asks (`retry-after`); any other 4xx is final.
 */
async function openWorkspaceVolume(sessionId: string, volume: WorkspaceVolume): Promise<void> {
  const origin = volumeOrigin(volume);
  let lastErr: unknown;
  let tries = 0;
  let waits = 0;
  for (;;) {
    try {
      const body = await platinumJson<{ region?: string }>(
        `/v1/volumes/${encodeURIComponent(volume.name)}`,
        // Always explicit: Platinum's code default is `drive` (live sync, keep-both).
        { method: 'PUT', body: JSON.stringify({ sync_mode: 'git' }), signal: AbortSignal.timeout(15_000) },
        origin,
      );
      if (volume.location && body.region && body.region !== volume.location) {
        throw new Error(`volume ${volume.name} answered from ${body.region}, not ${volume.location}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      const rateLimitWait = platinumRateLimitWaitMs(err);
      if (rateLimitWait !== null) {
        if (++waits > OPEN_RATE_LIMIT_WAITS) break;
        await Bun.sleep(rateLimitWait);
        continue;
      }
      // The PlatinumHttpError fields, read structurally.
      const status = Number((err as { status?: unknown } | null)?.status) || 0;
      if (status >= 400 && status < 500) break;
      if (++tries >= OPEN_TRIES) break;
      await Bun.sleep(tries * 2_000);
    }
  }
  const quota = (lastErr as { code?: unknown } | null)?.code === 'quota_exceeded';
  logger.warn(`[workspace] volume ${volume.name} did not open`, {
    sessionId,
    region: volume.location ?? 'home',
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  throw new Error(
    quota
      ? '[workspace] This session’s workspace volume could not be created: the workspace reached its storage volume limit. Delete old sessions, or ask Kortix for more.'
      : WORKSPACE_VOLUME_UNREACHABLE_MESSAGE,
  );
}

/**
 * Delete a volume. Platinum refuses with `volume_busy` while any box, running
 * or stopped, mounts it, and briefly after a sandbox DELETE answers, so that is
 * waited out for ~10 s. Throws on any other failure so the caller retries.
 */
async function deleteWorkspaceVolume(volume: WorkspaceVolume): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await platinumJson(
        `/v1/volumes/${encodeURIComponent(volume.name)}?missing_ok=true`,
        { method: 'DELETE', signal: AbortSignal.timeout(15_000) },
        volumeOrigin(volume),
      );
      return;
    } catch (err) {
      if (attempt >= 5 || (err as { code?: unknown } | null)?.code !== 'volume_busy') throw err;
      await Bun.sleep(2_000);
    }
  }
}

/**
 * Why a stopped box of this session must stay, or null when its volume holds
 * everything the box wrote and the box may go. Platinum's volume health
 * (`GET /v1/volumes/:v/health`) reads the mounts, merge queue, open commits and
 * blocks not yet in object storage; only `ok` lets the box go. A volume
 * Platinum cannot judge (no valid record, not found, no answer) keeps the box:
 * it may hold the session's only copy of a file. Never throws.
 */
export async function workspaceVolumeHoldReason(sessionId: string, sessionMetadata: unknown): Promise<string | null> {
  const volume = recordedWorkspaceVolume(sessionId, sessionMetadata);
  if (!volume) return 'the session has no valid workspace volume record';
  try {
    const health = await platinumJson<{ status?: string; reason?: string | null }>(
      // probe=false: the verdict on unsaved writes comes from Platinum's database, not the gateway host.
      `/v1/volumes/${encodeURIComponent(volume.name)}/health?probe=false`,
      { signal: AbortSignal.timeout(15_000) },
      volumeOrigin(volume),
    );
    return health.status === 'ok' ? null : `volume ${volume.name} is ${health.status ?? 'unknown'}: ${health.reason ?? 'no reason given'}`;
  } catch (err) {
    return `volume ${volume.name} health check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Delete the session's workspace volume when it has one: its content ended (purge, account erasure). Throws on failure. */
export async function deleteSessionWorkspaceVolume(sessionId: string, metadata: unknown): Promise<void> {
  const volume = recordedWorkspaceVolume(sessionId, metadata);
  if (!volume) return;
  await deleteWorkspaceVolume(volume);
  logger.info(`[workspace] deleted volume ${volume.name}`, { sessionId, region: volume.location ?? 'home' });
}

/** One saved workspace of the project, as Platinum describes the entry. */
export interface WorkspaceCacheEntry {
  id: string;
  key: string;
  size_bytes: number | null;
  file_count: number | null;
  hits: number;
  created_at: string | null;
  last_hit_at: string | null;
  expires_at: string | null;
}

/** A save or list the API cannot do: an HTTP status and a stable code for the route to answer with. */
export class WorkspaceCacheError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceCacheError';
  }
}

function entryOf(raw: Record<string, unknown>): WorkspaceCacheEntry {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: String(raw.id ?? ''),
    key: String(raw.key ?? ''),
    size_bytes: num(raw.size_bytes),
    file_count: num(raw.file_count),
    hits: num(raw.hits) ?? 0,
    created_at: str(raw.created_at),
    last_hit_at: str(raw.last_hit_at),
    expires_at: str(raw.expires_at),
  };
}

/** Platinum's refusal as the API's: a 4xx keeps its status and code, anything else is 502. */
function cacheFailure(err: unknown, what: string): WorkspaceCacheError {
  const status = Number((err as { status?: unknown } | null)?.status) || 0;
  const code = (err as { code?: unknown } | null)?.code;
  const detail = err instanceof Error ? err.message : String(err);
  // An org Platinum has not granted caches answers 404 on every /v1/caches route.
  if (status === 404 && (code === 'not_found' || code === undefined)) {
    return new WorkspaceCacheError(409, 'cache_unavailable', 'Platinum has no workspace cache for this Kortix deployment yet.');
  }
  if (status === 409 || status === 413 || status === 400 || status === 404) {
    return new WorkspaceCacheError(status, typeof code === 'string' ? code : 'cache_refused', `${what}: ${detail}`);
  }
  return new WorkspaceCacheError(502, 'cache_upstream', `${what}: ${detail}`);
}

/**
 * Save a session's /workspace as the project's newest workspace cache entry.
 * The caller checked the flag and that a person with project settings rights
 * asked. Running boxes' writes are committed first; the entry is pinned to
 * that commit, so a later write of the session never reaches the cache.
 * Keys are immutable (409 `cache_key_exists`); Platinum evicts the
 * namespace's oldest entries past its limit and the org budget.
 */
export async function saveWorkspaceCache(input: {
  projectId: string;
  sessionId: string;
  sessionMetadata: unknown;
  key: string;
}): Promise<{ entry: WorkspaceCacheEntry; evicted: string[]; commit_id: string | null }> {
  if (!isWorkspaceCacheKey(input.key)) {
    throw new WorkspaceCacheError(400, 'invalid_key', 'key must be `ws-` and 1-120 letters, numbers, dots, dashes, underscores, colons, plus or equals signs');
  }
  const volume = recordedWorkspaceVolume(input.sessionId, input.sessionMetadata);
  if (!volume) throw new WorkspaceCacheError(409, 'no_workspace_volume', 'This session has no /workspace volume to save.');
  const origin = volumeOrigin(volume);
  let commitId: string | null = null;
  try {
    const commit = await platinumJson<{ commit_id?: string; head_commit_id?: string }>(
      `/v1/volumes/${encodeURIComponent(volume.name)}/commit`,
      { method: 'POST', body: '{}', signal: AbortSignal.timeout(120_000) },
      origin,
    );
    commitId = commit.commit_id || commit.head_commit_id || null;
  } catch (err) {
    throw cacheFailure(err, `commit of ${volume.name}`);
  }
  try {
    const saved = await platinumJson<Record<string, unknown> & { evicted?: unknown }>(
      '/v1/caches',
      {
        method: 'POST',
        body: JSON.stringify({
          namespace: workspaceCacheNamespace(input.projectId),
          key: input.key,
          volume: volume.name,
          max_entries: WORKSPACE_CACHE_MAX_ENTRIES,
          ttl_seconds: WORKSPACE_CACHE_TTL_SECONDS,
          ...(commitId ? { ref: commitId } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      },
      origin,
    );
    const evicted = Array.isArray(saved.evicted) ? saved.evicted.filter((x): x is string => typeof x === 'string') : [];
    logger.info(`[workspace] saved ${volume.name} as workspace cache ${input.key}`, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      region: volume.location ?? 'home',
      commitId,
      evicted: evicted.length,
    });
    return { entry: entryOf(saved), evicted, commit_id: commitId };
  } catch (err) {
    throw cacheFailure(err, `save of ${volume.name} as ${input.key}`);
  }
}

/** The project's saved workspaces in one region (home when `location` is null), newest first, with the org's budget. */
export async function listWorkspaceCache(
  projectId: string,
  location: string | null,
): Promise<{ namespace: string; entries: WorkspaceCacheEntry[]; used_bytes: number | null; max_bytes: number | null }> {
  const namespace = workspaceCacheNamespace(projectId);
  try {
    const body = await platinumJson<{ entries?: unknown; used_bytes?: unknown; max_bytes?: unknown }>(
      `/v1/caches?namespace=${encodeURIComponent(namespace)}`,
      { signal: AbortSignal.timeout(15_000) },
      volumeOrigin({ name: '', location }),
    );
    const entries = Array.isArray(body.entries) ? (body.entries as Record<string, unknown>[]).map(entryOf) : [];
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { namespace, entries, used_bytes: n(body.used_bytes), max_bytes: n(body.max_bytes) };
  } catch (err) {
    throw cacheFailure(err, 'workspace cache list');
  }
}
