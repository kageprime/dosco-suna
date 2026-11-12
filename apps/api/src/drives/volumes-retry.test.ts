import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';

let statuses: number[] = [];
/** The body code per upstream answer; absent answers send the opaque-503 default `storage_unavailable`. */
let codes: string[] = [];
let calls = 0;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async () => {
    calls++;
    return Response.json(
      { id: 'synthetic-volume', code: codes.shift() ?? 'storage_unavailable' },
      { status: statuses.shift() ?? 200 },
    );
  },
}));
const { getDriveVolume, deleteDriveVolume, openDriveVolume, DriveStorageError } = await import('./volumes');
const VOLUME = { name: 'synthetic-volume', region: null, unfenced: true as const };
const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
afterEach(() => { calls = 0; statuses = []; codes = []; sleep.mockClear(); });
afterAll(() => sleep.mockRestore());

test('a volume read recovers from two transient storage 503s', async () => {
  statuses = [503, 503, 200];
  const result = await getDriveVolume(VOLUME);
  expect(result.id).toBe('synthetic-volume');
  expect(calls).toBe(3);
});

test('persistent storage failure remains a typed error after bounded retries', async () => {
  statuses = [503, 503, 503];
  const result = getDriveVolume(VOLUME).catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(3);
});

test('writes and non-transient read errors are never retried', async () => {
  statuses = [503];
  await expect(deleteDriveVolume(VOLUME)).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
  statuses = [404];
  await expect(getDriveVolume(VOLUME)).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(2);
});

test('an aborted read does not retry an upstream 503', async () => {
  statuses = [503];
  const controller = new AbortController();
  const result = getDriveVolume(VOLUME, controller.signal).catch((error: unknown) => error);
  controller.abort();
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
});

test('cancellation during backoff stops the next storage request', async () => {
  statuses = [503, 200];
  const controller = new AbortController();
  sleep.mockImplementationOnce(async () => { controller.abort(); });
  await expect(getDriveVolume(VOLUME, controller.signal)).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
});

test('a write on the upstream unavailable contract replays and lands', async () => {
  // The storage named the call it never ran: `503 {code:'unavailable'}` (the
  // prod write that surfaced as one typed 503 during the 2026-11-10 outage).
  statuses = [503, 200];
  codes = ['unavailable'];
  await expect(deleteDriveVolume(VOLUME)).resolves.toBeUndefined();
  expect(calls).toBe(2);
});

test('a persistent unavailable write stays a typed error after two retries', async () => {
  statuses = [503, 503, 503];
  codes = ['unavailable', 'unavailable'];
  const result = deleteDriveVolume(VOLUME).catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(3);
});

test('aborting during a write replay backoff stops the next storage request', async () => {
  statuses = [503, 200];
  codes = ['unavailable'];
  const controller = new AbortController();
  sleep.mockImplementationOnce(async () => { controller.abort(); });
  const result = openDriveVolume(VOLUME, controller.signal).catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
});
