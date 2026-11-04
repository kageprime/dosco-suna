import type { VolumeWriteCommit } from '../volume-commit';

/** The statuses a storage failure answers with. */
export type DriveStorageStatus = 400 | 403 | 404 | 409 | 413 | 422 | 429 | 503;

/**
 * The numbers of a limit refusal, as every refusal of a limit carries them:
 * which limit, its value, what is used and what the request asked for.
 */
export interface DriveLimitDetail {
  limit: string;
  max?: number;
  used?: number;
  requested?: number;
  /** The folder a folder-mount refusal is about. */
  path?: string;
}

/** A storage failure the drive routes turn into a response. `message` is user-facing. */
export class DriveStorageError extends Error {
  constructor(
    readonly status: DriveStorageStatus,
    message: string,
    readonly code?: string,
    /** A limit refusal's numbers, sent in the response body beside `code`. */
    readonly detail?: DriveLimitDetail,
    /** For a 429: seconds before the same request may be sent again (`Retry-After`). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DriveStorageError';
  }
}

/**
 * The status a route that predates the limit refusals answers (artifacts,
 * memory): the statuses it always had. A limit refusal reads as it did before
 * them: storage full 409, too large 413, busy 503.
 */
export function legacyDriveStatus(err: DriveStorageError): 400 | 404 | 409 | 413 | 503 {
  switch (err.status) {
    case 403:
      return 409;
    case 422:
      return 413;
    case 429:
      return 503;
    default:
      return err.status;
  }
}

export const GIB = 1024 ** 3;

/** `10 GB`, `512 MB`, `3.4 KB`: binary units, one decimal under 10. Server messages only; the apps format their own. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} bytes`;
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${units[unit]}`;
}

export interface DriveVolume {
  name: string;
  /** The region it lives in; null = home region. */
  region: string | null;
  /** A region move is copying it: every write is refused. */
  moving?: boolean;
  /** An operator's volume outside a drive row's life: writes skip the write fence. */
  unfenced?: true;
}

export interface VolumeInfo {
  id: string;
  logical_bytes: number;
  file_count: number;
  last_commit_at: string | null;
  head_commit_id?: string | null;
  size_limit_bytes?: number | null;
}

export interface VolumeEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export interface VolumeFileStat extends VolumeEntry {
  version: string | null;
  /** The file's permission bits, when storage reports them. */
  mode?: number;
}

export interface VolumeCommit {
  id: string;
  kind: string;
  author: { kind: string; id: string | null };
  created_at: string;
  on_head?: boolean;
  parent_id?: string | null;
  base_id?: string | null;
  merged_from?: string[];
  stats?: { changed_paths?: number; deleted_paths?: number };
}

export interface VolumeMount {
  sandboxId: string;
  mountPath: string;
  state: string;
}

export interface PlatinumMountLimits {
  max_mounts_per_sandbox?: number;
  max_total_mounts_per_sandbox?: number;
  node_share?: boolean;
  max_bytes_per_volume?: number;
  sub_path_max_bytes?: number;
  subdir_max_bytes?: number;
  max_file_bytes?: number;
  max_stored_bytes?: number | null;
  used_stored_bytes?: number;
}

export interface SandboxVolumeMount {
  mountPath: string;
  volume: string;
  readOnly: boolean;
  subdir: string;
}

export interface DriveStorageProvider {
  readonly name: string;

  // Volume Lifecycle
  openVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo>;
  getVolume(volume: DriveVolume, signal?: AbortSignal): Promise<VolumeInfo>;
  deleteVolume(volume: DriveVolume): Promise<void>;
  volumeHealth(volume: DriveVolume): Promise<{ status: string; reason: string | null }>;
  volumeLimits(): Promise<PlatinumMountLimits>;

  // File Operations
  listVolumeFiles(
    volume: DriveVolume,
    path: string,
    recursive: boolean,
    signal?: AbortSignal,
    at?: string,
  ): Promise<VolumeEntry[]>;

  listVolumeFilesPage(
    volume: DriveVolume,
    path: string,
    opts: { recursive: boolean; cursor?: string; signal?: AbortSignal; at?: string },
  ): Promise<{ entries: VolumeEntry[]; next_cursor: string | null }>;

  statVolumeFile(volume: DriveVolume, path: string, at?: string): Promise<VolumeFileStat>;

  readVolumeFile(
    volume: DriveVolume,
    path: string,
    range?: string,
    at?: string,
  ): Promise<Response>;

  writeVolumeFile(
    volume: DriveVolume,
    path: string,
    body: Uint8Array<ArrayBuffer>,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ path: string; size: number; version?: string; commit?: VolumeWriteCommit }>;

  writeVolumeFiles(
    volume: DriveVolume,
    files: Array<{ path: string; bytes: Uint8Array<ArrayBuffer> }>,
    opts: { overwrite: boolean },
  ): Promise<VolumeWriteCommit | undefined>;

  moveVolumeFile(volume: DriveVolume, src: string, dst: string): Promise<void>;

  removeVolumeFile(volume: DriveVolume, path: string, recursive: boolean): Promise<void>;

  volumeFolderUsage(volume: DriveVolume, path: string): Promise<{ bytes: number; complete: boolean } | null>;

  // Block Upload Protocol
  planVolumeUpload(volume: DriveVolume, plan: unknown): Promise<unknown>;

  putVolumeUploadBlock(
    volume: DriveVolume,
    uploadId: string,
    sha: string,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<void>;

  commitVolumeUpload(volume: DriveVolume, uploadId: string): Promise<unknown>;

  // Commits & History
  listVolumeCommits(
    volume: DriveVolume,
    limit?: number,
    opts?: { includeSide?: boolean; before?: string },
  ): Promise<VolumeCommit[]>;

  getVolumeCommit(volume: DriveVolume, commitId: string): Promise<VolumeCommit>;

  restoreVolume(volume: DriveVolume, to: string): Promise<void>;

  // Sandbox Attachments
  listVolumeMounts(volume: DriveVolume): Promise<VolumeMount[]>;

  sandboxVolumeMounts(externalId: string): Promise<SandboxVolumeMount[] | null>;

  attachSandboxVolume(
    externalId: string,
    mountPath: string,
    input: { volume: DriveVolume; readOnly: boolean; subdir?: string },
  ): Promise<void>;

  detachSandboxVolume(externalId: string, mountPath: string): Promise<void>;

  unmountInGuest(externalId: string, mountPath: string): Promise<void>;

  execInSandbox(externalId: string, script: string, timeoutMs?: number): Promise<void>;
}
