// The storage behind a drive: one Platinum volume in drive sync mode. Every
// call here speaks the Platinum volumes API; nothing above this file does.

import { createHash } from 'node:crypto';
import { drives } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { isPlatinumConfigured, platinumFetch, platinumRegionControlPlane } from '../shared/platinum';
import { DEFAULT_SANDBOX_MOUNT_LIMIT } from './access';
import { parseVolumeWriteCommit, type VolumeWriteCommit } from './volume-commit';
import { config } from '../config';
import {
  type DriveStorageStatus,
  type DriveLimitDetail,
  DriveStorageError,
  legacyDriveStatus,
  GIB,
  formatBytes,
  type DriveVolume,
  type VolumeInfo,
  type VolumeEntry,
  type VolumeFileStat,
  type VolumeCommit,
  type VolumeMount,
  type PlatinumMountLimits,
  type SandboxVolumeMount,
} from './storage/contract';
import { supabaseDriveStorage } from './storage/supabase';

export { parseVolumeWriteCommit, type VolumeWriteCommit } from './volume-commit';
export {
  type DriveStorageStatus,
  type DriveLimitDetail,
  DriveStorageError,
  legacyDriveStatus,
  GIB,
  formatBytes,
  type DriveVolume,
  type VolumeInfo,
  type VolumeEntry,
  type VolumeFileStat,
  type VolumeCommit,
  type VolumeMount,
  type PlatinumMountLimits,
  type SandboxVolumeMount,
};

/** Platinum's refusal body: `{error, code, limit?, max?, used?, requested?, path?, bytes?, max_bytes?}`. */
interface PlatinumRefusal {
  error?: string;
  code?: string;
  limit?: string;
  max?: number;
  used?: number;
  requested?: number;
  path?: string;
  bytes?: number;
  max_bytes?: number;
  scope?: string;
}

const finite = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/** The refusal's numbers, only those Platinum sent. */
function limitDetail(limit: string, body: PlatinumRefusal, fallback: { max?: number; used?: number } = {}): DriveLimitDetail {
  const max = finite(body.max) ?? finite(body.max_bytes) ?? fallback.max;
  const used = finite(body.used) ?? finite(body.bytes) ?? fallback.used;
  const requested = finite(body.requested);
  return {
    limit,
    ...(max !== undefined ? { max } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(requested !== undefined ? { requested } : {}),
    ...(typeof body.path === 'string' && body.path ? { path: body.path } : {}),
  };
}

/** Platinum's 413 file_too_large / payload_too_large. */
function fileTooLarge(body: PlatinumRefusal): DriveStorageError {
  const detail = limitDetail('file_bytes', body);
  const size = detail.requested !== undefined ? `This file is ${formatBytes(detail.requested)}. ` : '';
  const max = detail.max !== undefined ? `at most ${formatBytes(detail.max)}` : 'smaller';
  return new DriveStorageError(413, `${size}A file must be ${max}.`.trim(), body.code ?? 'file_too_large', detail);
}

/**
 * Platinum's 422 sub_path_too_large. At a mount it names a folder too large
 * to mount; at a write (Platinum #2422) a write that would take a folder that
 * sessions mount past the folder-mount cap.
 */
export function folderTooLarge(body: PlatinumRefusal, atWrite: boolean): DriveStorageError {
  const detail = limitDetail('sub_path_bytes', body, { max: 10 * GIB });
  const folder = detail.path ? `The folder ${detail.path}` : 'This folder';
  const cap = formatBytes(detail.max ?? 10 * GIB);
  const holds = detail.used === undefined
    ? ''
    : `It holds ${formatBytes(detail.used)}${atWrite && detail.requested !== undefined ? `, and this adds ${formatBytes(detail.requested)}` : ''}.`;
  const message = atWrite
    ? [`${folder} is mounted in sessions, and a folder a session mounts can hold at most ${cap}.`, holds, 'Put the file in another folder, or move large files out of this one.']
    : [`${folder} is too large to mount in a session: a folder a session mounts can hold at most ${cap}.`, holds];
  return new DriveStorageError(422, message.filter(Boolean).join(' '), 'sub_path_too_large', detail);
}

/** Platinum's 403 quota_exceeded, by the limit it names. */
function quotaExceeded(body: PlatinumRefusal, path: string): DriveStorageError {
  const limit = body.limit ?? 'bytes';
  if ((limit === 'bytes' || limit === 'stored_bytes') && body.scope !== 'org') {
    // The project's volume is full (its size, or what it stores with history).
    const detail = limitDetail('volume_bytes', body);
    const numbers = detail.max !== undefined && detail.used !== undefined ? `: ${formatBytes(detail.used)} of ${formatBytes(detail.max)} used` : '';
    return new DriveStorageError(
      403,
      `This project's Files are full${numbers}. Delete files you no longer need, then try again.`,
      'storage_limit_exceeded',
      detail,
    );
  }
  if (limit === 'volumes') {
    return new DriveStorageError(403, 'Dosco file storage cannot add more drives right now. Try again later.', 'quota_exceeded', limitDetail('volumes', body));
  }
  // The org-wide figure: Dosco's own storage is full, not this customer's.
  logger.error(`[drives] Platinum refused a write for the org-wide storage limit (${limit}): ${path}`, { body });
  return new DriveStorageError(403, 'Dosco file storage is at capacity right now. Try again later.', 'quota_exceeded', limitDetail(limit, body));
}

/** Seconds from a `Retry-After` header, clamped to 1-30; 1 when absent or a date. */
export function retryAfterSeconds(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.min(30, Math.ceil(n)) : 1;
}

export function driveStorageAvailable(): boolean {
  return isPlatinumConfigured() || Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
}

const FILE_TIMEOUT_MS = 5 * 60_000;
/** Re-sends of a write Platinum refused with 429 transfer_limit_exceeded. */
const TRANSFER_RETRIES = 3;

export const FILE_CHANGED_MESSAGE = 'This file changed since you opened it. Reload it to see the latest version, then save again.';

export const DRIVE_MOVING_MESSAGE = 'These files are moving to another region. Try again in a minute.';

/**
 * The write fence, checked when a write is sent, not when the caller read the
 * drive row: a write that read the row before a region move fenced it, or
 * before the move pointed the row at its new volume, is refused here instead
 * of landing in the volume the move copies from. Only a row that still names
 * this volume, with no move running, may write it. One indexed read per write.
 */
export async function assertDriveWritable(volume: DriveVolume): Promise<void> {
  if (volume.unfenced) return;
  if (!volume.moving) {
    const [row] = await db
      .select({ move: drives.platinumVolumeMove })
      .from(drives)
      .where(eq(drives.platinumVolumeName, volume.name))
      .limit(1);
    if (row && !(row.move && !row.move.finished_at)) return;
  }
  throw new DriveStorageError(503, DRIVE_MOVING_MESSAGE, 'drive_moving');
}

/** The control plane that owns the volume: its region's own, or the global origin for home. */
function volumeOrigin(volume: DriveVolume): string | undefined {
  if (!volume.region) return undefined;
  const origin = platinumRegionControlPlane(volume.region);
  if (!origin) {
    logger.warn(`[drives] no Platinum control plane is known for region ${volume.region}`);
    throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
  }
  return origin;
}

/**
 * One Platinum call. `volume` names the drive volume the call is about (its
 * region's control plane gets it); null is a call about a sandbox or the
 * account, which shared/platinum.ts routes by sandbox id.
 */
async function call(volume: DriveVolume | null, path: string, init: RequestInit = {}, allowRangeRefusal = false): Promise<Response> {
  if (!driveStorageAvailable()) throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
  const method = (init.method ?? 'GET').toUpperCase();
  // An upload's blocks change nothing until its commit, which is checked.
  if (volume && method !== 'GET' && !/\/files\/upload\/[^/]+\/blocks\//.test(path)) await assertDriveWritable(volume);
  const origin = volume ? volumeOrigin(volume) : undefined;
  let res: Response;
  try {
    res = await platinumFetch(path, init, origin);
    // Reads are safe to replay while storage recovers; writes may have committed.
    for (const delay of [2_000, 3_000]) {
      if (method !== 'GET' || res.status !== 503 || init.signal?.aborted) break;
      await res.body?.cancel();
      await Bun.sleep(delay);
      init.signal?.throwIfAborted();
      res = await platinumFetch(path, init, origin);
    }
    // A write Platinum refused for its bytes in flight (429, #2422) never ran:
    // it is sent again after Retry-After, up to 3 times (at most 5 s apart).
    for (let attempt = 0; attempt < TRANSFER_RETRIES; attempt++) {
      if (res.status !== 429 || init.signal?.aborted) break;
      const wait = Math.min(5, retryAfterSeconds(res.headers.get('retry-after'))) * 1_000;
      const head = await res.clone().json().catch(() => ({}) as { code?: string });
      if ((head as { code?: string }).code !== 'transfer_limit_exceeded') break;
      await res.body?.cancel();
      await Bun.sleep(wait);
      init.signal?.throwIfAborted();
      res = await platinumFetch(path, init, origin);
    }
  } catch (err) {
    logger.warn(`[drives] ${init.method ?? 'GET'} ${path} failed:`, { error: err instanceof Error ? err.message : String(err) });
    throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
  }
  if (res.ok || (allowRangeRefusal && res.status === 416)) return res;
  const text = await res.text().catch(() => '');
  let refusal: PlatinumRefusal = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') refusal = parsed as PlatinumRefusal;
  } catch {
    refusal = {};
  }
  const code = typeof refusal.code === 'string' ? refusal.code : undefined;
  switch (res.status) {
    case 400:
      throw new DriveStorageError(400, 'Invalid path', code);
    case 404:
      throw new DriveStorageError(404, code === 'volume_not_found' ? 'Drive not found' : 'File or folder not found', code);
    case 403:
      if (code === 'quota_exceeded') throw quotaExceeded(refusal, path);
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 403 ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
    case 409:
      if (code === 'volume_busy') throw new DriveStorageError(409, 'The drive is attached to a running session', code);
      if (code === 'not_a_directory') throw new DriveStorageError(409, 'That path is a file, not a folder', code);
      if (code === 'volume_in_other_region') {
        logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 409 ${text.slice(0, 300)}`);
        throw new DriveStorageError(409, 'These files live in another region than this session', code);
      }
      throw new DriveStorageError(409, 'A file or folder with that name already exists', code);
    case 412:
      throw new DriveStorageError(409, FILE_CHANGED_MESSAGE, 'file_changed');
    case 413:
      throw fileTooLarge(refusal);
    case 422:
      // A sandbox mount (`/v1/sandboxes/…`) is about mounting; a volume write is a write.
      if (code === 'sub_path_too_large') throw folderTooLarge(refusal, volume !== null);
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> 422 ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
    case 429:
      // Platinum's bytes-in-flight cap (#2422) or its upload slots: a busy
      // volume, never "storage unavailable". The caller may send it again.
      throw new DriveStorageError(
        429,
        'File storage is busy with other uploads to these files. Try again in a moment.',
        code ?? 'rate_limited',
        code === 'transfer_limit_exceeded' ? limitDetail('transfer_bytes', refusal) : undefined,
        retryAfterSeconds(res.headers.get('retry-after')),
      );
    default:
      logger.warn(`[drives] ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', code);
  }
}

async function callJson<T>(volume: DriveVolume | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await call(volume, path, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const v = (volume: DriveVolume) => `/v1/volumes/${encodeURIComponent(volume.name)}`;

/**
 * What one folder holds, summed the way a folder mount sums it
 * (`GET /v1/volumes/:v/files/usage?path=`, #2422; Platinum caches it per
 * commit). Null on a Platinum without the route or for a missing folder.
 */
export async function volumeFolderUsage(volume: DriveVolume, path: string): Promise<{ bytes: number; complete: boolean } | null> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.volumeFolderUsage(volume, path);
  }
  try {
    const r = await callJson<{ bytes?: number; complete?: boolean }>(volume, `${v(volume)}/files/usage?${new URLSearchParams({ path })}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return Number.isFinite(Number(r.bytes)) ? { bytes: Number(r.bytes), complete: r.complete !== false } : null;
  } catch (err) {
    if (err instanceof DriveStorageError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/** The volume does not exist on this storage account (never opened here, or deleted). */
export function isMissingVolume(err: unknown): boolean {
  return err instanceof DriveStorageError && err.code === 'volume_not_found';
}

/**
 * Open-or-create by name in the volume's region, so a retry after a lost
 * response never makes a second volume.
 */
export async function openDriveVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.openVolume(volume, signal);
  }
  try {
    const info = await callJson<VolumeInfo & { region?: string }>(volume, v(volume), {
      method: 'PUT',
      body: JSON.stringify({ sync_mode: 'drive' }),
      ...(signal ? { signal } : {}),
    });
    if (volume.region && info.region && info.region !== volume.region) {
      logger.warn(`[drives] volume ${volume.name} answered from ${info.region}, not ${volume.region}`);
      throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
    }
    return info;
  } catch (err) {
    // A 404 here means volumes are not enabled for the storage account: not a
    // missing file, and not the caller's to fix.
    if (err instanceof DriveStorageError && (err.status === 404 || err.status === 400)) {
      throw new DriveStorageError(503, 'Drive storage is not available', 'drive_storage_unavailable');
    }
    throw err;
  }
}

export async function getDriveVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.getVolume(volume, signal);
  }
  return callJson<VolumeInfo>(volume, v(volume), signal ? { signal } : {});
}

export async function deleteDriveVolume(volume: DriveVolume): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.deleteVolume(volume);
  }
  await call(volume, `${v(volume)}?missing_ok=true`, { method: 'DELETE' });
}

export async function listVolumeFiles(
  volume: DriveVolume,
  path: string,
  recursive: boolean,
  signal?: AbortSignal,
  at?: string,
): Promise<VolumeEntry[]> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.listVolumeFiles(volume, path, recursive, signal, at);
  }
  const q = new URLSearchParams({ path, recursive: String(recursive), limit: '10000', ...(at ? { at } : {}) });
  const r = await callJson<{ entries: VolumeEntry[] }>(volume, `${v(volume)}/files?${q}`, signal ? { signal } : {});
  return r.entries ?? [];
}

/** A file's bytes; `at` reads it as it was at that commit. */
export async function readVolumeFile(volume: DriveVolume, path: string, range?: string, at?: string): Promise<Response> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.readVolumeFile(volume, path, range, at);
  }
  const q = new URLSearchParams({ path, ...(at ? { at } : {}) });
  return call(volume, `${v(volume)}/files/content?${q}`, {
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: range ? { Range: range } : {},
  }, true);
}

export async function writeVolumeFile(
  volume: DriveVolume,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  opts: { overwrite: boolean; ifMatch?: string },
): Promise<{ path: string; size: number; version?: string; commit?: VolumeWriteCommit }> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.writeVolumeFile(volume, path, body, opts);
  }
  const q = new URLSearchParams({ path, overwrite: String(opts.overwrite) });
  const r = await callJson<{ path: string; size: number; version?: string }>(volume, `${v(volume)}/files/content?${q}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    // Storage lands the write only while the file is at this version, in the
    // same step as the write: two saves from one version cannot both land.
    headers: { 'Content-Type': 'application/octet-stream', ...(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {}) },
  });
  const commit = parseVolumeWriteCommit(r);
  return { path: r.path ?? path, size: Number(r.size ?? body.byteLength), ...(r.version ? { version: String(r.version) } : {}), ...(commit ? { commit } : {}) };
}

/** One page of a listing, for callers that walk a whole drive (drive sync). */
export async function listVolumeFilesPage(
  volume: DriveVolume,
  path: string,
  opts: { recursive: boolean; cursor?: string; signal?: AbortSignal; at?: string },
): Promise<{ entries: VolumeEntry[]; next_cursor: string | null }> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.listVolumeFilesPage(volume, path, opts);
  }
  const q = new URLSearchParams({ path, recursive: String(opts.recursive), limit: '5000' });
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.at) q.set('at', opts.at);
  const r = await callJson<{ entries: VolumeEntry[]; next_cursor?: string | null }>(volume, `${v(volume)}/files?${q}`,
    opts.signal ? { signal: opts.signal } : {},
  );
  return { entries: r.entries ?? [], next_cursor: r.next_cursor ?? null };
}

/** A file's metadata; `at` stats it as it was at that commit. */
export async function statVolumeFile(volume: DriveVolume, path: string, at?: string): Promise<VolumeFileStat> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.statVolumeFile(volume, path, at);
  }
  const q = new URLSearchParams({ path, ...(at ? { at } : {}) });
  const r = await callJson<VolumeFileStat>(volume, `${v(volume)}/files/stat?${q}`, { signal: AbortSignal.timeout(30_000) });
  return {
    path: r.path,
    type: r.type,
    size: Number(r.size ?? 0),
    mtime: Number(r.mtime ?? 0),
    version: r.version ?? null,
    ...(Number.isInteger(r.mode) ? { mode: Number(r.mode) } : {}),
  };
}

/**
 * The block upload protocol, for files too large for one PUT: plan (the
 * store answers which 1 MiB blocks it lacks), send only those, commit.
 */
export async function planVolumeUpload(volume: DriveVolume, plan: unknown): Promise<unknown> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.planVolumeUpload(volume, plan);
  }
  return callJson<unknown>(volume, `${v(volume)}/files/upload`, {
    method: 'POST',
    body: JSON.stringify(plan),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function putVolumeUploadBlock(volume: DriveVolume, uploadId: string, sha: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.putVolumeUploadBlock(volume, uploadId, sha, body);
  }
  await call(volume, `${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/blocks/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

export async function commitVolumeUpload(volume: DriveVolume, uploadId: string): Promise<unknown> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.commitVolumeUpload(volume, uploadId);
  }
  return callJson<unknown>(volume, `${v(volume)}/files/upload/${encodeURIComponent(uploadId)}/commit`, {
    method: 'POST',
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

const BLOCK_BYTES = 1024 * 1024;
const BLOCK_CONCURRENCY = 8;

/**
 * Write many files as ONE commit, through the block protocol: the store
 * answers which 1 MiB blocks it lacks, only those travel (8 at a time), and the
 * commit lands every file at once. A reader never sees half a folder.
 */
export async function writeVolumeFiles(
  volume: DriveVolume,
  files: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }>,
  opts: { overwrite: boolean },
): Promise<VolumeWriteCommit | undefined> {
  if (!files.length) return;
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.writeVolumeFiles(volume, files, opts);
  }
  const blocks = new Map<string, Uint8Array<ArrayBuffer>>();
  const planned = files.map((f) => {
    const shas: string[] = [];
    for (let off = 0; off < f.bytes.byteLength; off += BLOCK_BYTES) {
      const block = f.bytes.subarray(off, Math.min(f.bytes.byteLength, off + BLOCK_BYTES));
      const sha = createHash('sha256').update(block).digest('hex');
      blocks.set(sha, block);
      shas.push(sha);
    }
    return { path: f.path, size: f.bytes.byteLength, blocks: shas };
  });
  const plan = (await planVolumeUpload(volume, { files: planned, overwrite: opts.overwrite })) as { upload_id: string; missing?: string[] };
  const missing = [...new Set(plan.missing ?? [])];
  for (let i = 0; i < missing.length; i += BLOCK_CONCURRENCY) {
    await Promise.all(missing.slice(i, i + BLOCK_CONCURRENCY).map((sha) => putVolumeUploadBlock(volume, plan.upload_id, sha, blocks.get(sha)!)));
  }
  return parseVolumeWriteCommit(await commitVolumeUpload(volume, plan.upload_id));
}

export async function moveVolumeFile(volume: DriveVolume, src: string, dst: string): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.moveVolumeFile(volume, src, dst);
  }
  await call(volume, `${v(volume)}/files/move`, {
    method: 'POST',
    body: JSON.stringify({ src, dst, overwrite: false }),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
}

export async function removeVolumeFile(volume: DriveVolume, path: string, recursive: boolean): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.removeVolumeFile(volume, path, recursive);
  }
  const q = new URLSearchParams({ path, recursive: String(recursive) });
  await call(volume, `${v(volume)}/files?${q}`, { method: 'DELETE', signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
}

export async function listVolumeCommits(volume: DriveVolume, limit = 100, opts: { includeSide?: boolean; before?: string } = {}): Promise<VolumeCommit[]> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.listVolumeCommits(volume, limit, opts);
  }
  const query = new URLSearchParams({ limit: String(limit), ...(opts.includeSide ? { include_side: 'true' } : {}), ...(opts.before ? { before: opts.before } : {}) });
  const r = await callJson<{ commits: VolumeCommit[] }>(volume, `${v(volume)}/commits?${query}`);
  return r.commits ?? [];
}

export async function getVolumeCommit(volume: DriveVolume, commitId: string): Promise<VolumeCommit> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.getVolumeCommit(volume, commitId);
  }
  return callJson<VolumeCommit>(volume, `${v(volume)}/commits/${encodeURIComponent(commitId)}`);
}

/**
 * Platinum's verdict on whether the volume holds everything written to it:
 * `ok` once no mount, merge queue, open commit or block not yet in object
 * storage holds a write. `probe=false` reads it from Platinum's database.
 */
export async function volumeHealth(volume: DriveVolume): Promise<{ status: string; reason: string | null }> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.volumeHealth(volume);
  }
  const r = await callJson<{ status?: string; reason?: string | null }>(volume, `${v(volume)}/health?probe=false`, { signal: AbortSignal.timeout(15_000) });
  return { status: r.status ?? 'unknown', reason: r.reason ?? null };
}

/** Every mount of the volume that has not ended, on any sandbox (`GET /v1/volumes/:v/mounts`). */
export async function listVolumeMounts(volume: DriveVolume): Promise<VolumeMount[]> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.listVolumeMounts(volume);
  }
  const r = await callJson<{ mounts?: Array<Record<string, unknown>> }>(volume, `${v(volume)}/mounts`, { signal: AbortSignal.timeout(15_000) });
  return (r.mounts ?? []).map((m) => ({
    sandboxId: String(m.sandbox_id ?? ''),
    mountPath: String(m.mount_path ?? ''),
    state: String(m.state ?? ''),
  }));
}

export async function restoreVolume(volume: DriveVolume, to: string): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.restoreVolume(volume, to);
  }
  await call(volume, `${v(volume)}/restore`, { method: 'POST', body: JSON.stringify({ to }) });
}

// replica-local: Platinum's org limits change only by an operator, so a stale copy for 10 minutes is harmless. `at` = when it expires.
let platinumLimitsCache: { value: PlatinumMountLimits; at: number } | null = null;
const PLATINUM_LIMITS_TTL_MS = 10 * 60_000;

/** After a failed read, the next one waits this long, so a storage outage is not asked on every request. */
const PLATINUM_LIMITS_RETRY_MS = 30_000;
// replica-local: the one read in flight, shared by concurrent callers.
let platinumLimitsRead: Promise<PlatinumMountLimits> | null = null;

/** Platinum's limits for Dosco's org, cached 10 minutes. `{}` when they cannot be read (for 30 s). */
export async function platinumVolumeLimits(): Promise<PlatinumMountLimits> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.volumeLimits();
  }
  if (platinumLimitsCache && Date.now() < platinumLimitsCache.at) return platinumLimitsCache.value;
  platinumLimitsRead ??= callJson<PlatinumMountLimits>(null, '/v1/volumes/limits', { signal: AbortSignal.timeout(5_000) })
    .then((value) => {
      platinumLimitsCache = { value, at: Date.now() + PLATINUM_LIMITS_TTL_MS };
      return value;
    })
    .catch((err: unknown) => {
      logger.warn('[drives] reading the Platinum volume limits failed:', { error: err instanceof Error ? err.message : String(err) });
      platinumLimitsCache = { value: {}, at: Date.now() + PLATINUM_LIMITS_RETRY_MS };
      return {} as PlatinumMountLimits;
    })
    .finally(() => {
      platinumLimitsRead = null;
    });
  return platinumLimitsRead;
}

/**
 * How many folders one sandbox mounts. Every drive mount asks for share
 * "node"; with node share on they take no disk, so the plan uses the total
 * cap, else the private one. {@link DEFAULT_SANDBOX_MOUNT_LIMIT} when unknown.
 */
export function mountSlotsFrom(limits: PlatinumMountLimits): number {
  const pick = limits.node_share ? limits.max_total_mounts_per_sandbox : limits.max_mounts_per_sandbox;
  const max = Number(pick ?? limits.max_mounts_per_sandbox);
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_SANDBOX_MOUNT_LIMIT;
}

/** {@link mountSlotsFrom} Platinum's live limits. Cached; the default when they cannot be read. */
export async function sandboxMountLimit(): Promise<number> {
  return mountSlotsFrom(await platinumVolumeLimits());
}

/** The volume mounts a sandbox has now, or null when Platinum cannot say. */
export async function sandboxVolumeMounts(externalId: string): Promise<SandboxVolumeMount[] | null> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.sandboxVolumeMounts(externalId);
  }
  try {
    const body = await callJson<{ volume_mounts?: Array<Record<string, unknown>> | Record<string, unknown> }>(
      null,
      `/v1/sandboxes/${encodeURIComponent(externalId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const mounts = body.volume_mounts;
    if (!mounts) return [];
    if (!Array.isArray(mounts)) {
      return Object.keys(mounts).map((mountPath) => ({ mountPath, volume: '', readOnly: false, subdir: '/' }));
    }
    return mounts.map((m) => ({
      mountPath: String(m.mount_path ?? m.path ?? ''),
      volume: String(m.volume_name ?? m.volume_id ?? ''),
      readOnly: m.read_only === true,
      subdir: typeof m.subdir === 'string' && m.subdir ? m.subdir : '/',
    }));
  } catch {
    return null;
  }
}

/** The volume mounts a sandbox has now, by mount path, or null when Platinum cannot say. */
export async function sandboxMountPaths(externalId: string): Promise<string[] | null> {
  const mounts = await sandboxVolumeMounts(externalId);
  return mounts && mounts.map((m) => m.mountPath);
}

const sandboxMount = (externalId: string, mountPath: string) =>
  `/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(mountPath)}`;

/**
 * Hot-attach a volume to a running sandbox. Platinum answers 201 once the
 * guest mounted it, 202 while the mount is still pending (it lands within
 * seconds); both count as attached. A sandbox mounts only a volume of its own
 * region: another region's answers `volume_in_other_region`.
 */
export async function attachSandboxVolume(
  externalId: string,
  mountPath: string,
  input: { volume: DriveVolume; readOnly: boolean; subdir?: string },
): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.attachSandboxVolume(externalId, mountPath, input);
  }
  // A box writes through its mount: the same fence as any write.
  await assertDriveWritable(input.volume);
  try {
    await call(null, sandboxMount(externalId, mountPath), {
      method: 'POST',
      body: JSON.stringify({
        volume: input.volume.name,
        read_only: input.readOnly,
        ...(input.subdir ? { subdir: input.subdir } : {}),
        share: 'node',
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    if (!(err instanceof DriveStorageError)) throw err;
    if (err.code === 'quota_exceeded') {
      throw new DriveStorageError(
        409,
        'This session already mounts as many drives as a session can. Take a drive out of it first.',
        'drive_mount_limit',
      );
    }
    if (err.code === 'sandbox_not_running') {
      throw new DriveStorageError(409, 'The session is not running; the drive mounts when it starts', err.code);
    }
    if (err.code === 'path_exists') {
      throw new DriveStorageError(409, 'Another drive is already mounted at that path', err.code);
    }
    if (err.code === 'template_lacks_volume_support') {
      throw new DriveStorageError(409, 'This session’s sandbox image cannot mount drives', err.code);
    }
    throw err;
  }
}

/**
 * Detach one mount from a running (or stopped) sandbox, committing its last
 * changes first. A mount that is already gone counts as detached.
 */
export async function detachSandboxVolume(externalId: string, mountPath: string): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.detachSandboxVolume(externalId, mountPath);
  }
  try {
    await call(null, sandboxMount(externalId, mountPath), {
      method: 'DELETE',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DriveStorageError && err.status === 404) return;
    throw err;
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Unmount a folder path inside the guest when the guest still has something
 * mounted there that Platinum no longer tracks (a VM resumed from memory keeps
 * the mounts its kernel had, after Platinum ended them at the stop).
 */
export async function unmountInGuest(externalId: string, mountPath: string): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.unmountInGuest(externalId, mountPath);
  }
  const q = shellQuote(mountPath);
  await execInSandbox(externalId, `if mountpoint -q ${q}; then umount ${q} 2>/dev/null || umount -l ${q}; fi`);
}

/**
 * Run a short script as root in a running sandbox (the sandbox exec runs as
 * the runtime user, which has passwordless sudo). Throws on any failure.
 */
export async function execInSandbox(externalId: string, script: string, timeoutMs = 20_000): Promise<void> {
  if (!isPlatinumConfigured()) {
    return supabaseDriveStorage.execInSandbox(externalId, script, timeoutMs);
  }
  let res: Response;
  try {
    res = await call(null, `/v1/sandboxes/${encodeURIComponent(externalId)}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: ['bash', '-c', `sudo -n bash -c ${shellQuote(script)}`], timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
  } catch (err) {
    // The storage error copy is about files; an exec refusal is about the sandbox.
    throw new Error(`exec refused: ${err instanceof DriveStorageError ? `${err.status} ${err.code ?? ''}` : String(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { result?: { exit_code?: number; stderr?: string; error?: string } };
  const code = body.result?.exit_code;
  if (code !== 0) throw new Error(`exec exited ${code ?? '?'}: ${(body.result?.stderr ?? body.result?.error ?? '').slice(0, 200)}`);
}
