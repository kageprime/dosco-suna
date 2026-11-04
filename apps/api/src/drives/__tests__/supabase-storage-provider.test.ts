import { describe, expect, test } from 'bun:test';
import {
  supabaseDriveStorage,
  DriveStorageError,
  legacyDriveStatus,
  formatBytes,
  GIB,
  type DriveVolume,
} from '../storage';

describe('Supabase Drive Storage Provider', () => {
  const dummyVolume: DriveVolume = { name: 'vol-test-supabase', region: null };

  test('conforms to provider contract name', () => {
    expect(supabaseDriveStorage.name).toBe('supabase');
  });

  test('volumeLimits returns standard local defaults', async () => {
    const limits = await supabaseDriveStorage.volumeLimits();
    expect(limits.max_mounts_per_sandbox).toBe(16);
    expect(limits.max_total_mounts_per_sandbox).toBe(16);
    expect(limits.node_share).toBe(true);
    expect(limits.max_bytes_per_volume).toBe(10 * GIB);
    expect(limits.max_file_bytes).toBe(1 * GIB);
  });

  test('volumeHealth returns ok status', async () => {
    const health = await supabaseDriveStorage.volumeHealth(dummyVolume);
    expect(health).toEqual({ status: 'ok', reason: null });
  });

  test('mount operations return empty arrays or resolve as no-ops', async () => {
    expect(await supabaseDriveStorage.listVolumeMounts(dummyVolume)).toEqual([]);
    expect(await supabaseDriveStorage.sandboxVolumeMounts('sandbox-dummy')).toEqual([]);

    await expect(
      supabaseDriveStorage.attachSandboxVolume('sandbox-dummy', '/workspace/mnt', {
        volume: dummyVolume,
        readOnly: false,
      }),
    ).resolves.toBeUndefined();

    await expect(
      supabaseDriveStorage.detachSandboxVolume('sandbox-dummy', '/workspace/mnt'),
    ).resolves.toBeUndefined();

    await expect(
      supabaseDriveStorage.unmountInGuest('sandbox-dummy', '/workspace/mnt'),
    ).resolves.toBeUndefined();

    await expect(
      supabaseDriveStorage.execInSandbox('sandbox-dummy', 'echo 1'),
    ).resolves.toBeUndefined();
  });

  test('commit operations return default values without error', async () => {
    expect(await supabaseDriveStorage.listVolumeCommits(dummyVolume)).toEqual([]);
    const commit = await supabaseDriveStorage.getVolumeCommit(dummyVolume, 'commit-xyz');
    expect(commit.id).toBe('commit-xyz');
    expect(commit.kind).toBe('init');
    await expect(supabaseDriveStorage.restoreVolume(dummyVolume, 'commit-xyz')).resolves.toBeUndefined();
  });

  test('planVolumeUpload and putVolumeUploadBlock handle block tracking', async () => {
    const planResult = (await supabaseDriveStorage.planVolumeUpload(dummyVolume, {
      files: [{ path: 'test.bin', size: 10, blocks: ['sha-1', 'sha-2'] }],
      overwrite: true,
    })) as { upload_id: string; missing: string[] };

    expect(planResult.upload_id).toBeDefined();
    expect(planResult.missing).toEqual(['sha-1', 'sha-2']);

    const block1 = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(
      supabaseDriveStorage.putVolumeUploadBlock(dummyVolume, planResult.upload_id, 'sha-1', block1),
    ).resolves.toBeUndefined();

    await expect(
      supabaseDriveStorage.putVolumeUploadBlock(dummyVolume, 'nonexistent-upload', 'sha-1', block1),
    ).rejects.toThrow(DriveStorageError);
  });

  test('DriveStorageError correctly exposes status, detail and legacy mapping', () => {
    const err = new DriveStorageError(422, 'Too large', 'sub_path_too_large', {
      limit: 'sub_path_bytes',
      max: 10 * GIB,
      used: 11 * GIB,
    });
    expect(err.status).toBe(422);
    expect(err.code).toBe('sub_path_too_large');
    expect(err.detail?.limit).toBe('sub_path_bytes');
    expect(legacyDriveStatus(err)).toBe(413);

    const errQuota = new DriveStorageError(403, 'Quota full', 'quota_exceeded');
    expect(legacyDriveStatus(errQuota)).toBe(409);

    const errRate = new DriveStorageError(429, 'Busy', 'rate_limited');
    expect(legacyDriveStatus(errRate)).toBe(503);
  });

  test('formatBytes formats human readable byte units', () => {
    expect(formatBytes(500)).toBe('500 bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(10 * GIB)).toBe('10 GB');
  });
});
