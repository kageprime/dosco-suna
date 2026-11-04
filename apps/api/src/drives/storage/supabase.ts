import { getSupabase } from '../../shared/supabase';
import { logger } from '../../lib/logger';
import type { VolumeWriteCommit } from '../volume-commit';
import {
  type DriveStorageProvider,
  type DriveVolume,
  type VolumeInfo,
  type VolumeEntry,
  type VolumeFileStat,
  type VolumeCommit,
  type VolumeMount,
  type PlatinumMountLimits,
  type SandboxVolumeMount,
  DriveStorageError,
  GIB,
} from './contract';

const DRIVES_BUCKET = 'drives';
let drivesBucketChecked = false;

export async function getDrivesStorage() {
  const supabase = getSupabase();
  if (!drivesBucketChecked) {
    await supabase.storage.createBucket(DRIVES_BUCKET, { public: false }).catch(() => null);
    drivesBucketChecked = true;
  }
  return supabase.storage.from(DRIVES_BUCKET);
}

export function volumeStorageKey(volume: DriveVolume, path: string): string {
  const norm = path.startsWith('/') ? path : `/${path}`;
  return `${volume.name}${norm}`.replace(/^\/+/, '');
}

interface PendingUpload {
  volume: DriveVolume;
  plan: { files: Array<{ path: string; size: number; blocks: string[] }>; overwrite: boolean };
  blocks: Map<string, Uint8Array<ArrayBuffer>>;
  createdAt: number;
}
const pendingUploads = new Map<string, PendingUpload>();

export async function listSupabaseFiles(
  volume: DriveVolume,
  folderPath: string,
  recursive: boolean,
): Promise<VolumeEntry[]> {
  const bucket = await getDrivesStorage();
  const results: VolumeEntry[] = [];
  const startPath = folderPath === '/' ? '' : (folderPath.startsWith('/') ? folderPath : `/${folderPath}`);
  const queue = [startPath];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const prefix = (current ? `${volume.name}${current}` : volume.name).replace(/^\/+/, '').replace(/\/+$/, '');
    const { data, error } = await bucket.list(prefix, { limit: 1000 });
    if (error || !data) continue;

    for (const item of data) {
      const itemPath = `${current}/${item.name}`;
      if (item.id === null) {
        // Directory
        results.push({
          path: itemPath,
          type: 'dir',
          size: 0,
          mtime: 0,
        });
        if (recursive) {
          queue.push(itemPath);
        }
      } else {
        // File
        results.push({
          path: itemPath,
          type: 'file',
          size: Number(item.metadata?.size ?? 0),
          mtime: Date.parse(item.updated_at ?? item.created_at ?? '') || 0,
        });
      }
    }
  }
  return results;
}

export class SupabaseDriveStorage implements DriveStorageProvider {
  readonly name = 'supabase';

  async openVolume(volume: DriveVolume, _signal?: AbortSignal): Promise<VolumeInfo> {
    await getDrivesStorage();
    return {
      id: volume.name,
      logical_bytes: 0,
      file_count: 0,
      last_commit_at: new Date().toISOString(),
    };
  }

  async getVolume(volume: DriveVolume, _signal?: AbortSignal): Promise<VolumeInfo> {
    return {
      id: volume.name,
      logical_bytes: 0,
      file_count: 0,
      last_commit_at: new Date().toISOString(),
    };
  }

  async deleteVolume(volume: DriveVolume): Promise<void> {
    const entries = await listSupabaseFiles(volume, '/', true);
    const keys = entries.filter((e) => e.type === 'file').map((e) => volumeStorageKey(volume, e.path));
    if (keys.length > 0) {
      const bucket = await getDrivesStorage();
      await bucket.remove(keys);
    }
  }

  async volumeHealth(_volume: DriveVolume): Promise<{ status: string; reason: string | null }> {
    return { status: 'ok', reason: null };
  }

  async volumeLimits(): Promise<PlatinumMountLimits> {
    return {
      max_mounts_per_sandbox: 16,
      max_total_mounts_per_sandbox: 16,
      node_share: true,
      max_bytes_per_volume: 10 * GIB,
      sub_path_max_bytes: 10 * GIB,
      subdir_max_bytes: 10 * GIB,
      max_file_bytes: 1 * GIB,
      max_stored_bytes: null,
      used_stored_bytes: 0,
    };
  }

  async listVolumeFiles(
    volume: DriveVolume,
    path: string,
    recursive: boolean,
    _signal?: AbortSignal,
    _at?: string,
  ): Promise<VolumeEntry[]> {
    return listSupabaseFiles(volume, path, recursive);
  }

  async listVolumeFilesPage(
    volume: DriveVolume,
    path: string,
    opts: { recursive: boolean; cursor?: string; signal?: AbortSignal; at?: string },
  ): Promise<{ entries: VolumeEntry[]; next_cursor: string | null }> {
    const all = await listSupabaseFiles(volume, path, opts.recursive);
    const startIndex = opts.cursor ? parseInt(opts.cursor, 10) || 0 : 0;
    const page = all.slice(startIndex, startIndex + 5000);
    const nextCursor = startIndex + 5000 < all.length ? String(startIndex + 5000) : null;
    return { entries: page, next_cursor: nextCursor };
  }

  async statVolumeFile(volume: DriveVolume, path: string, _at?: string): Promise<VolumeFileStat> {
    if (path === '/' || path === '') {
      return {
        path: '/',
        type: 'dir',
        size: 0,
        mtime: Date.now(),
        version: null,
      };
    }
    const key = volumeStorageKey(volume, path);
    const folder = key.slice(0, key.lastIndexOf('/'));
    const name = key.slice(key.lastIndexOf('/') + 1);
    const bucket = await getDrivesStorage();
    const { data } = await bucket.list(folder, { search: name });
    const match = data?.find((e) => e.name === name);
    if (!match) {
      throw new DriveStorageError(404, 'File or folder not found', 'file_not_found');
    }
    const isDir = match.id === null;
    return {
      path,
      type: isDir ? 'dir' : 'file',
      size: Number(match.metadata?.size ?? 0),
      mtime: Date.parse(match.updated_at ?? match.created_at ?? '') || Date.now(),
      version: match.version ?? String(Date.now()),
    };
  }

  async readVolumeFile(volume: DriveVolume, path: string, range?: string, _at?: string): Promise<Response> {
    const key = volumeStorageKey(volume, path);
    const bucket = await getDrivesStorage();
    const { data, error } = await bucket.download(key);
    if (error || !data) {
      throw new DriveStorageError(404, 'File or folder not found', 'file_not_found');
    }
    const arrayBuffer = await data.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const total = bytes.byteLength;

    if (range && range.startsWith('bytes=')) {
      const parts = range.slice(6).split('-');
      const startStr = parts[0];
      const endStr = parts[1];
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : total - 1;
      if (isNaN(start)) {
        start = Math.max(0, total - (parseInt(endStr, 10) || 0));
        end = total - 1;
      }
      if (start >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      end = Math.min(end, total - 1);
      const sliced = bytes.subarray(start, end + 1);
      return new Response(sliced, {
        status: 206,
        headers: {
          'Content-Type': data.type || 'application/octet-stream',
          'Content-Length': String(sliced.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          ETag: `"${total}-${data.size}"`,
        },
      });
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': data.type || 'application/octet-stream',
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        ETag: `"${total}"`,
      },
    });
  }

  async writeVolumeFile(
    volume: DriveVolume,
    path: string,
    body: Uint8Array<ArrayBuffer>,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ path: string; size: number; version?: string; commit?: VolumeWriteCommit }> {
    const key = volumeStorageKey(volume, path);
    const bucket = await getDrivesStorage();
    if (!opts.overwrite) {
      const folder = key.slice(0, key.lastIndexOf('/'));
      const name = key.slice(key.lastIndexOf('/') + 1);
      const { data: existing } = await bucket.list(folder, { search: name });
      if (existing && existing.some((e) => e.name === name)) {
        throw new DriveStorageError(409, 'A file or folder with that name already exists', 'file_exists');
      }
    }
    const { error } = await bucket.upload(key, body, {
      upsert: opts.overwrite,
      contentType: 'application/octet-stream',
    });
    if (error) {
      logger.warn('[drives] Supabase upload failed:', { error: String(error) });
      throw new DriveStorageError(503, 'Drive storage write failed', 'storage_error');
    }
    const version = String(Date.now());
    const commit: VolumeWriteCommit = {
      commit_id: crypto.randomUUID().replace(/-/g, ''),
      outcome: 'fast',
    };
    return {
      path,
      size: body.byteLength,
      version,
      commit,
    };
  }

  async writeVolumeFiles(
    volume: DriveVolume,
    files: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }>,
    opts: { overwrite: boolean },
  ): Promise<VolumeWriteCommit | undefined> {
    if (!files.length) return;
    for (const f of files) {
      await this.writeVolumeFile(volume, f.path, f.bytes, opts);
    }
    return {
      commit_id: crypto.randomUUID().replace(/-/g, ''),
      outcome: 'fast',
    };
  }

  async moveVolumeFile(volume: DriveVolume, src: string, dst: string): Promise<void> {
    const fromKey = volumeStorageKey(volume, src);
    const toKey = volumeStorageKey(volume, dst);
    const bucket = await getDrivesStorage();
    const { error } = await bucket.move(fromKey, toKey);
    if (error) {
      // If src is directory, move all entries under it
      const entries = await listSupabaseFiles(volume, src, true);
      if (entries.length > 0) {
        for (const entry of entries) {
          if (entry.type === 'file') {
            const rel = entry.path.slice(src.length);
            await bucket.move(volumeStorageKey(volume, entry.path), volumeStorageKey(volume, `${dst}${rel}`));
          }
        }
      } else {
        throw new DriveStorageError(503, 'Failed to move file', 'move_failed');
      }
    }
  }

  async removeVolumeFile(volume: DriveVolume, path: string, recursive: boolean): Promise<void> {
    const bucket = await getDrivesStorage();
    const key = volumeStorageKey(volume, path);
    if (recursive) {
      const entries = await listSupabaseFiles(volume, path, true);
      const keys = entries.filter((e) => e.type === 'file').map((e) => volumeStorageKey(volume, e.path));
      keys.push(key);
      await bucket.remove(keys);
    } else {
      await bucket.remove([key]);
    }
  }

  async volumeFolderUsage(volume: DriveVolume, path: string): Promise<{ bytes: number; complete: boolean } | null> {
    try {
      const entries = await listSupabaseFiles(volume, path, true);
      const bytes = entries.filter((e) => e.type === 'file').reduce((acc, e) => acc + (e.size || 0), 0);
      return { bytes, complete: true };
    } catch {
      return null;
    }
  }

  async planVolumeUpload(volume: DriveVolume, plan: unknown): Promise<unknown> {
    const uploadId = crypto.randomUUID();
    const typedPlan = plan as { files: Array<{ path: string; size: number; blocks: string[] }>; overwrite: boolean };
    pendingUploads.set(uploadId, {
      volume,
      plan: typedPlan,
      blocks: new Map(),
      createdAt: Date.now(),
    });
    const missing = (typedPlan.files ?? []).flatMap((f) => f.blocks ?? []);
    return { upload_id: uploadId, missing };
  }

  async putVolumeUploadBlock(_volume: DriveVolume, uploadId: string, sha: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
    const pending = pendingUploads.get(uploadId);
    if (!pending) throw new DriveStorageError(404, 'Upload plan not found', 'upload_not_found');
    pending.blocks.set(sha, body);
  }

  async commitVolumeUpload(volume: DriveVolume, uploadId: string): Promise<unknown> {
    const pending = pendingUploads.get(uploadId);
    if (!pending) throw new DriveStorageError(404, 'Upload plan not found', 'upload_not_found');
    pendingUploads.delete(uploadId);

    const writtenFiles: Array<{ path: string; size: number; version: string }> = [];
    for (const f of pending.plan.files) {
      const parts = f.blocks.map((sha) => pending.blocks.get(sha)).filter((b): b is Uint8Array<ArrayBuffer> => Boolean(b));
      const totalLen = parts.reduce((acc, p) => acc + p.byteLength, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of parts) {
        combined.set(p, offset);
        offset += p.byteLength;
      }
      const res = await this.writeVolumeFile(volume, f.path, combined, { overwrite: pending.plan.overwrite });
      writtenFiles.push({ path: f.path, size: combined.byteLength, version: res.version ?? String(Date.now()) });
    }
    return {
      commit_id: crypto.randomUUID().replace(/-/g, ''),
      outcome: 'fast',
    };
  }

  async listVolumeCommits(_volume: DriveVolume, _limit = 100, _opts: { includeSide?: boolean; before?: string } = {}): Promise<VolumeCommit[]> {
    return [];
  }

  async getVolumeCommit(_volume: DriveVolume, commitId: string): Promise<VolumeCommit> {
    return {
      id: commitId,
      kind: 'init',
      author: { kind: 'system', id: null },
      created_at: new Date().toISOString(),
    };
  }

  async restoreVolume(_volume: DriveVolume, _to: string): Promise<void> {
    return;
  }

  async listVolumeMounts(_volume: DriveVolume): Promise<VolumeMount[]> {
    return [];
  }

  async sandboxVolumeMounts(_externalId: string): Promise<SandboxVolumeMount[] | null> {
    return [];
  }

  async attachSandboxVolume(
    _externalId: string,
    _mountPath: string,
    _input: { volume: DriveVolume; readOnly: boolean; subdir?: string },
  ): Promise<void> {
    return;
  }

  async detachSandboxVolume(_externalId: string, _mountPath: string): Promise<void> {
    return;
  }

  async unmountInGuest(_externalId: string, _mountPath: string): Promise<void> {
    return;
  }

  async execInSandbox(_externalId: string, _script: string, _timeoutMs = 20_000): Promise<void> {
    return;
  }
}

export const supabaseDriveStorage = new SupabaseDriveStorage();
