// The conflict scan pass: a drive whose storage calls fail backs off — the
// same shape the search indexer already has — instead of failing again every
// 15 s pass. KRTX-4686: Platinum's volume API hung for hours and the scanner
// logged two warn lines per active drive per pass (710 lines), while the
// indexer, which backs off, logged 6x less for the same failing calls.
//
// The learnings (2026-09-28, KRTX-614 and KRTX-338) set the warn rule these
// tests hold: never one warning per retry attempt, and a warn marks the
// transition into the failing state — a success re-arms it.

import { expect, mock, test } from 'bun:test';

// ── the fake storage: kd-d1 hangs on every read, kd-d2 answers its head ────
const failVolumeNames = new Set(['kd-d1']);
const volumeCalls: string[] = [];

export class FakeDriveStorageError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DriveStorageError';
  }
}

mock.module('./volumes', () => ({
  DriveStorageError: FakeDriveStorageError,
  getDriveVolume: async (volume: { name: string }) => {
    volumeCalls.push(volume.name);
    if (failVolumeNames.has(volume.name)) {
      await Bun.sleep(2);
      throw new FakeDriveStorageError(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
    }
    return { id: volume.name, head_commit_id: 'h1' };
  },
  isMissingVolume: (err: unknown) => err instanceof FakeDriveStorageError && err.code === 'volume_not_found',
  listVolumeFiles: async () => [],
  readVolumeFile: async () => {
    throw new Error('not read in these tests');
  },
}));

// ── two drives, both already scanned at head h1 ────────────────────────────
const driveRows = [
  { driveId: 'd1', platinumVolumeId: 'v1', platinumVolumeName: 'kd-d1', platinumVolumeRegion: null, conflictScanHead: 'h1' },
  { driveId: 'd2', platinumVolumeId: 'v2', platinumVolumeName: 'kd-d2', platinumVolumeRegion: null, conflictScanHead: 'h1' },
];
const mountList = [{ driveId: 'd1' }, { driveId: 'd2' }];

const tableRows = new Map<string, unknown[]>([
  ['drives', driveRows],
  ['sessionSandboxes', [{ metadata: {} }]],
  ['driveConflicts', []],
]);
// A chainable thenable: every builder method returns another chain, and an
// await resolves the table's rows (never a real query).
function chain(result: unknown[]): unknown {
  return new Proxy(() => {}, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (r: unknown[]) => void) => res(result);
      return () => chain(result);
    },
  });
}

// Every export the graph needs is a table stub carrying its name; the db stub
// below reads it.
const dbTables = ['accounts', 'driveConflicts', 'driveIndexEntries', 'drives', 'projects', 'sessionSandboxes'];
mock.module(
  '@kortix/db',
  () =>
    Object.fromEntries(dbTables.map((name) => [name, { __t: name }])),
);
mock.module('../shared/db', () => ({
  db: {
    select: () => ({ from: (t: { __t?: string }) => chain(tableRows.get(t.__t ?? '') ?? []) }),
    update: () => chain([]),
    insert: () => chain([]),
    delete: () => chain([]),
  },
}));
mock.module('./service', () => ({
  DRIVE_MOUNTS_METADATA_KEY: 'driveMounts',
  driveVolume: (d: { platinumVolumeName: string; platinumVolumeRegion: string | null }) => ({
    name: d.platinumVolumeName,
    region: d.platinumVolumeRegion ?? null,
  }),
  recordedDriveMounts: () => mountList,
  refreshDriveNotes: () => {},
}));

const warns: string[] = [];
mock.module('../lib/logger', () => ({
  logger: {
    warn: (message: string) => warns.push(message),
    info: () => {},
    error: () => {},
  },
}));

const { runConflictScan } = await import('./conflicts');
const { createDriveBackoff } = await import('./backoff');

test('a drive whose scan fails backs off: later passes skip it and do not warn again', async () => {
  await runConflictScan(); // pass 1: d1 times out, d2 succeeds
  await runConflictScan(); // pass 2
  await runConflictScan(); // pass 3
  expect(volumeCalls).toEqual(['kd-d1', 'kd-d2', 'kd-d2', 'kd-d2']);
  expect(warns.filter((m) => m.includes('conflict scan of d1'))).toHaveLength(1);
});

test('a failed drive waits 30 s doubling to the cap, and only until the wait elapses', () => {
  const b = createDriveBackoff(45_000);
  const down = new FakeDriveStorageError(503, 'Drive storage is unavailable', 'drive_storage_unavailable');
  expect(b.fail('d1', down)).toEqual({ waitMs: 30_000, firstFailure: true });
  expect(b.fail('d1', down)).toEqual({ waitMs: 45_000, firstFailure: false }); // 60 s capped at 45 s
  expect(b.waiting().has('d1')).toBe(true);
  expect(b.waiting(Date.now() + 46_000).has('d1')).toBe(false); // elapsed: skipped, not forgotten
  // A sustained outage: the attempt after the wait keeps doubling and stays quiet.
  expect(b.fail('d1', down)).toEqual({ waitMs: 45_000, firstFailure: false });
});

test('storage\'s Retry-After wins when it asks longer than the doubling', () => {
  const b = createDriveBackoff(30 * 60_000);
  expect(b.fail('d1', new FakeDriveStorageError(429, 'rate limited', 'rate_limited', 120)).waitMs).toBe(120_000);
});

test('a success re-arms the warn: the next failure is a first failure again', () => {
  const b = createDriveBackoff(30 * 60_000);
  b.fail('d1', new Error('down'));
  expect(b.fail('d1', new Error('down')).firstFailure).toBe(false);
  b.ok('d1');
  expect(b.fail('d1', new Error('down')).firstFailure).toBe(true);
});
