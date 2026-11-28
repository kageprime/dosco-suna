/**
 * Integration test (real PostgreSQL): the volume input rules, pinned before
 * their dedupe (KRTX-4617). One refusal per validator, answered through the
 * public entry points that own it today: create (name, then size), update
 * (the size ceiling, then retention), fork (name, then the snapshot tag), and
 * the 409 of destroying an attached volume. The provider store is never
 * reached: every refused call fails before it.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { MAX_VOLUME_GB } from '@kortix/shared/app-config';
import { appVolumes, apps } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { AppVolumeError, createAppVolume, destroyVolume, forkVolume, updateAppVolume } from './volumes';
import { appVolumeStore } from './volume-store';

const open = spyOn(appVolumeStore, 'open').mockResolvedValue(undefined);
let project: SeededProject;
const USER_ID = crypto.randomUUID();
const APP_ID = crypto.randomUUID();

const seedVolume = async (attached: boolean): Promise<string> => {
  const volumeId = crypto.randomUUID();
  await db.insert(appVolumes).values({
    volumeId,
    appId: APP_ID,
    accountId: project.account_id,
    name: 'data',
    sizeGb: 10,
    externalId: `kapp-test-${volumeId}`,
    status: 'ready',
    attachedRuntimeId: attached ? crypto.randomUUID() : null,
  });
  return volumeId;
};

beforeAll(async () => {
  project = await seedProject('volumes-validators');
  await db.insert(apps).values({
    appId: APP_ID, accountId: project.account_id, projectId: project.project_id,
    slug: 'volumes', name: 'volumes', routeKey: 'vo1umesroutekey01', createdBy: USER_ID,
  });
});

afterAll(async () => {
  await db.delete(appVolumes).where(eq(appVolumes.appId, APP_ID));
  await db.delete(apps).where(eq(apps.appId, APP_ID));
  await removeSeeded([project]);
  open.mockRestore();
});

const refuse = (call: () => Promise<unknown>) => call().then(
  () => { throw new Error('expected a refusal'); },
  (error: unknown) => {
    expect(error).toBeInstanceOf(AppVolumeError);
    return error as AppVolumeError;
  },
);

test('create refuses a bad name first, then a bad size', async () => {
  const badName = await refuse(() => createAppVolume({ appId: APP_ID, accountId: project.account_id, name: 'Bad Name', sizeGb: 0, retentionDays: 0 }));
  expect(badName).toMatchObject({ status: 400, code: 'volume_name_invalid', message: 'A volume name is 1-30 lowercase letters, digits or "_".' });

  const zero = await refuse(() => createAppVolume({ appId: APP_ID, accountId: project.account_id, name: 'ok', sizeGb: 0, retentionDays: 0 }));
  expect(zero).toMatchObject({ status: 400, code: 'volume_size_invalid', message: `size_gb must be 1 to ${MAX_VOLUME_GB}.` });

  const huge = await refuse(() => createAppVolume({ appId: APP_ID, accountId: project.account_id, name: 'ok', sizeGb: MAX_VOLUME_GB + 1 }));
  expect(huge).toMatchObject({ status: 400, code: 'volume_size_invalid', message: `size_gb must be 1 to ${MAX_VOLUME_GB}.` });

  const fraction = await refuse(() => createAppVolume({ appId: APP_ID, accountId: project.account_id, name: 'ok', sizeGb: 10.5 }));
  expect(fraction).toMatchObject({ status: 400, code: 'volume_size_invalid' });
});

test.each([0, 61, 1.5])('create refuses retention %s before inserting or opening a provider volume', async (retentionDays) => {
  const before = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
  const calls = open.mock.calls.length;
  const error = await refuse(() => createAppVolume({
    appId: APP_ID, accountId: project.account_id, name: 'invalid_retention', sizeGb: 10, retentionDays,
  }));
  expect(error).toMatchObject({ status: 400, code: 'volume_retention_invalid', message: 'snapshot_retention_days must be 1 to 60.' });
  expect(await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID))).toEqual(before);
  expect(open.mock.calls.length).toBe(calls);
});

test('create persists both retention boundaries and the omitted default', async () => {
  for (const retentionDays of [1, 60, undefined]) {
    const volume = await createAppVolume({
      appId: APP_ID, accountId: project.account_id, name: `retention_${retentionDays ?? 'default'}`, sizeGb: 10, retentionDays,
    });
    const [stored] = await db.select().from(appVolumes).where(eq(appVolumes.volumeId, volume.volumeId));
    expect(stored?.snapshotRetentionDays).toBe(retentionDays ?? 5);
    expect(stored?.status).toBe('ready');
    expect(open).toHaveBeenCalledWith(volume.externalId);
  }
});

test('update refuses a size above the ceiling and an out-of-range retention', async () => {
  const volumeId = await seedVolume(false);

  const huge = await refuse(() => updateAppVolume(APP_ID, volumeId, { sizeGb: MAX_VOLUME_GB + 1 }));
  expect(huge).toMatchObject({ status: 400, code: 'volume_size_invalid', message: `size_gb must be at most ${MAX_VOLUME_GB}.` });

  const low = await refuse(() => updateAppVolume(APP_ID, volumeId, { retentionDays: 0 }));
  expect(low).toMatchObject({ status: 400, code: 'volume_retention_invalid', message: 'snapshot_retention_days must be 1 to 60.' });

  const high = await refuse(() => updateAppVolume(APP_ID, volumeId, { retentionDays: 61 }));
  expect(high).toMatchObject({ status: 400, code: 'volume_retention_invalid' });

  const fraction = await refuse(() => updateAppVolume(APP_ID, volumeId, { retentionDays: 1.5 }));
  expect(fraction).toMatchObject({ status: 400, code: 'volume_retention_invalid' });
});

test('fork refuses a bad name and an unknown snapshot tag', async () => {
  const volumeId = await seedVolume(false);

  const badName = await refuse(() => forkVolume(APP_ID, volumeId, { name: 'NO PEAS' }));
  expect(badName).toMatchObject({ status: 400, code: 'volume_name_invalid', message: 'A volume name is 1-30 lowercase letters, digits or "_".' });

  const badTag = await refuse(() => forkVolume(APP_ID, volumeId, { name: 'ok', snapshotId: 'not-a-tag' }));
  expect(badTag).toMatchObject({ status: 400, code: 'snapshot_invalid', message: 'Unknown snapshot.' });
});

test('destroying an attached volume is 409 volume_attached', async () => {
  const volumeId = await seedVolume(true);
  const attached = await refuse(() => destroyVolume(APP_ID, volumeId));
  expect(attached).toMatchObject({ status: 409, code: 'volume_attached' });
});
