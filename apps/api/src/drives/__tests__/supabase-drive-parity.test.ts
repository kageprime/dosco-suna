import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { config } from '../../config';
import {
  driveStorageAvailable,
  volumeFolderUsage,
  listVolumeMounts,
  platinumVolumeLimits,
  sandboxVolumeMounts,
} from '../volumes';
import { driveSyncEnabled } from '../sync';

describe('Supabase Drive Parity without Platinum', () => {
  const origPlatinumKey = config.PLATINUM_API_KEY;
  const origSupabaseUrl = config.SUPABASE_URL;
  const origSupabaseKey = config.SUPABASE_SERVICE_ROLE_KEY;
  const origDrivesSync = config.KORTIX_DRIVES_SYNC;

  beforeEach(() => {
    (config as Record<string, unknown>).PLATINUM_API_KEY = undefined;
    (config as Record<string, unknown>).SUPABASE_URL = 'http://127.0.0.1:54321';
    (config as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    (config as Record<string, unknown>).KORTIX_DRIVES_SYNC = undefined;
  });

  afterEach(() => {
    (config as Record<string, unknown>).PLATINUM_API_KEY = origPlatinumKey;
    (config as Record<string, unknown>).SUPABASE_URL = origSupabaseUrl;
    (config as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY = origSupabaseKey;
    (config as Record<string, unknown>).KORTIX_DRIVES_SYNC = origDrivesSync;
  });

  test('driveStorageAvailable returns true when Supabase is configured without Platinum', () => {
    expect(driveStorageAvailable()).toBe(true);
  });

  test('driveSyncEnabled defaults to true when Platinum is absent and Supabase storage is available', () => {
    expect(driveSyncEnabled()).toBe(true);
  });

  test('driveSyncEnabled respects explicit operator disable flag', () => {
    config.KORTIX_DRIVES_SYNC = 'off';
    expect(driveSyncEnabled()).toBe(false);

    config.KORTIX_DRIVES_SYNC = 'false';
    expect(driveSyncEnabled()).toBe(false);

    config.KORTIX_DRIVES_SYNC = '0';
    expect(driveSyncEnabled()).toBe(false);
  });

  test('driveSyncEnabled respects explicit operator enable flag', () => {
    config.KORTIX_DRIVES_SYNC = 'on';
    expect(driveSyncEnabled()).toBe(true);
  });

  test('platinumVolumeLimits returns default quota limits without Platinum', async () => {
    const limits = await platinumVolumeLimits();
    expect(limits.max_mounts_per_sandbox).toBe(16);
    expect(limits.node_share).toBe(true);
    expect(limits.max_bytes_per_volume).toBe(10 * 1024 ** 3);
  });

  test('listVolumeMounts returns empty array without Platinum', async () => {
    const mounts = await listVolumeMounts({ name: 'vol-test', region: null });
    expect(mounts).toEqual([]);
  });

  test('sandboxVolumeMounts returns empty array without Platinum', async () => {
    const mounts = await sandboxVolumeMounts('sbx-test-123');
    expect(mounts).toEqual([]);
  });
});
