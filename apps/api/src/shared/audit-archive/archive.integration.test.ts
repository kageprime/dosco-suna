import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from '../../__tests__/helpers/pg-client';
import { db } from '../db';
import { type ArchiveStore, exportWeek, runArchivePass } from './archive';
import { decodeRows, retainUntil, weekEnd, weekStartOf } from './format';

const databaseUrl = process.env.TEST_DATABASE_URL;
const A1 = 'b9200000-0000-4000-a000-000000000001';
const A2 = 'b9200000-0000-4000-a000-000000000002';
const A3 = 'b9200000-0000-4000-a000-000000000003';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

interface Stored { body: Buffer; retainUntil: Date; mode: string }

function fakeStore() {
  const objects = new Map<string, Stored>();
  const store: ArchiveStore & { objects: Map<string, Stored>; corrupt: Set<string> } = {
    objects,
    corrupt: new Set(),
    async putLocked(input) {
      if (objects.has(input.key)) return 'exists';
      objects.set(input.key, { body: input.body, retainUntil: input.retainUntil, mode: input.mode });
      return 'created';
    },
    async checksum(key) {
      const object = objects.get(key);
      if (!object) return null;
      if (store.corrupt.has(key)) return 'AAAA';
      return createHash('sha256').update(object.body).digest('base64');
    },
  };
  return store;
}

let client: PgClient | null = null;
const q = (text: string, values?: unknown[]) => client!.query(text, values);

async function seed(accountId: string | null, action: string, at: string, n = 1) {
  await q(
    `INSERT INTO kortix.audit_events(account_id, action, resource_type, authoritative_source, occurred_at)
     SELECT $1, $2, 'test', 'system', $3::timestamptz + g * interval '1 second' FROM generate_series(1, $4) g`,
    [accountId, action, at, n],
  );
}

describe.skipIf(!databaseUrl)('audit archive — export, verify, remove (real PostgreSQL, in-memory store)', () => {
  const w1 = weekStartOf(new Date(Date.now() - 170 * DAY));
  const w2 = weekStartOf(new Date(Date.now() - 150 * DAY));
  const w3 = weekStartOf(new Date(Date.now() - 130 * DAY));
  const deps = (store: ArchiveStore, extra: Record<string, unknown> = {}) => ({
    db, store, mode: 'COMPLIANCE' as const, rowsPerSecond: 1_000_000, batchRows: 3, ...extra,
  });

  beforeAll(async () => {
    client = new PgClient({ connectionString: databaseUrl });
    await client.connect();
    // Weeks far enough back to be archivable exist as partitions (the migration keeps 85 days).
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 200, 8)`);
    // Old history lives in the legacy table; w1 also has late rows in its partition; w3 only in a partition.
    await q(`INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
             SELECT a, 'legacy.row', 'test', 'system', $1::timestamptz + g * interval '1 minute'
               FROM unnest($2::uuid[]) a, generate_series(1, 4) g`, [daysAgo(170), [A1, A2]]);
    await q(`INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
             VALUES (NULL, 'legacy.anonymous', 'test', 'system', $1), ($2, 'legacy.w2', 'test', 'system', $3)`, [daysAgo(170), A1, daysAgo(150)]);
    await seed(A1, 'late.row', daysAgo(169), 2);
    await seed(A2, 'partition.w3', daysAgo(130), 5);
    await seed(A1, 'partition.hot', daysAgo(1), 3);
  });

  afterAll(async () => {
    if (!client) return;
    await q(`SET kortix.audit_maintenance = 'on'`);
    await q(`DELETE FROM kortix.audit_events WHERE account_id = ANY($1::uuid[])`, [[A1, A2, A3]]);
    await q(`DELETE FROM kortix.audit_archive_chunks`);
    await client.end();
  });

  test('a corrupted upload stops the week before anything is removed', async () => {
    const store = fakeStore();
    const original = store.putLocked.bind(store);
    store.putLocked = async (input) => {
      const outcome = await original(input);
      if (input.key.includes(`/${w3}.`)) store.corrupt.add(input.key);
      return outcome;
    };
    await expect(exportWeek(deps(store), w3)).rejects.toThrow(/does not match the exported rows/);
    const chunk = await q(`SELECT status FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w3]);
    expect(chunk.rows[0]?.status).toBe('exporting');
    const held = await q(`SELECT count(*)::int AS n FROM kortix.audit_events WHERE action = 'partition.w3'`);
    expect(held.rows[0].n).toBe(5);
  });

  test('exports one object family per account and week, with Object Lock until week end + 365 days', async () => {
    const store = fakeStore();
    const result = await exportWeek(deps(store), w3);
    expect(result.rows).toBe(5);
    expect(result.legacyRows).toBe(0);
    const keys = [...store.objects.keys()].sort();
    expect(keys).toEqual([`audit/${A2}/${w3.slice(0, 4)}/${w3}.000.jsonl.gz`, `audit/_manifest/${w3}.json`].sort());
    for (const object of store.objects.values()) {
      expect(object.mode).toBe('COMPLIANCE');
      expect(object.retainUntil.getTime()).toBe(retainUntil(w3).getTime());
    }
    const lines = decodeRows(store.objects.get(keys.find((k) => k.endsWith('.jsonl.gz'))!)!.body);
    expect(lines).toHaveLength(5);
    expect(lines.every((row) => row.account_id === A2 && row.action === 'partition.w3')).toBe(true);
    // occurred_at is UTC with microseconds, whatever the session time zone: fixed width, so string order is time order.
    expect(lines.every((row) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(String(row.occurred_at)))).toBe(true);
    // Ascending by (occurred_at, event_id).
    const times = lines.map((row) => new Date(String(row.occurred_at)).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // A second export of the same week writes nothing new and still verifies.
    const again = await exportWeek(deps(store), w3);
    expect(again.manifestSha256).toBe(result.manifestSha256);
    expect(store.objects.size).toBe(2);
  });

  test('the export is rate-capped: batches never finish faster than rows / rowsPerSecond', async () => {
    const sleeps: number[] = [];
    const store = fakeStore();
    await exportWeek(deps(store, { rowsPerSecond: 10, batchRows: 2, sleep: async (ms: number) => void sleeps.push(ms) }), w3);
    // 5 rows in batches of 2: three batches, each owed >= (rows / 10 s) minus the time it took.
    expect(sleeps.length).toBe(3);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(400);
  });

  test('the legacy share of a week is read under the same rate cap, and each account merges both tables in order', async () => {
    const inWeek = `occurred_at >= $1::date AND occurred_at < $1::date + 7`;
    const legacyRows = (await q(`SELECT count(*)::int AS n FROM kortix.audit_events_legacy WHERE ${inWeek}`, [w1])).rows[0].n;
    const allRows = (await q(`SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE ${inWeek}`, [w1])).rows[0].n;
    expect(legacyRows).toBe(9);
    const sleeps: number[] = [];
    const store = fakeStore();
    const result = await exportWeek(deps(store, { rowsPerSecond: 1, sleep: async (ms: number) => void sleeps.push(ms) }), w1);
    expect(result).toMatchObject({ rows: allRows, legacyRows });
    // Tallied legacy rows count against the cap too: legacyRows + allRows rows at 1 row/s. The sleeps
    // are recorded, not slept, so the last one is what the rows owe minus the real time spent
    // (well under 3 s). Without the tally it would be at most allRows seconds.
    expect(Math.max(...sleeps)).toBeGreaterThan((legacyRows + allRows) * 1000 - 3_000);
    const a1 = [...store.objects].filter(([k]) => k.startsWith(`audit/${A1}/`)).flatMap(([, o]) => decodeRows(o.body));
    const order = a1.map((row) => `${row.occurred_at}|${row.event_id}`);
    expect(order).toEqual([...order].sort());
    expect(new Set(a1.map((row) => row.event_id)).size).toBe(a1.length);
    // The pass below archives w1 again, from scratch.
    await q(`DELETE FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w1]);
  });

  test('an export stopped mid-week resumes after its last recorded part: the tally is read once, no finished part is read or uploaded again, and the manifest equals an uninterrupted export', async () => {
    // A legacy-only week: A1 5 rows, A3 3 rows, no account 1 row. With 2 rows per part:
    // A1 .000 .001 .002, A3 .000 .001, _none .000 (accounts ascending, NULL last).
    const w5 = weekStartOf(new Date(Date.now() - 160 * DAY));
    const at = new Date(new Date(`${w5}T00:00:00Z`).getTime() + 2 * DAY).toISOString();
    await q(`INSERT INTO kortix.audit_events_legacy(account_id, action, resource_type, authoritative_source, occurred_at)
             SELECT a, 'legacy.w5', 'test', 'system', $1::timestamptz + g * interval '1 minute'
               FROM (VALUES ($2::uuid, 5), ($3::uuid, 3), (NULL::uuid, 1)) v(a, n), generate_series(1, v.n) g`, [at, A1, A3]);
    const objects = new Map<string, Stored>();
    const puts: string[][] = [];
    /** A store over the shared bucket whose put number `crashAt` of this run stores the object, then throws (the process dies before it records the part). */
    const run = (crashAt: number | null) => {
      const store = fakeStore();
      for (const [k, v] of objects) store.objects.set(k, v);
      const seen: string[] = [];
      puts.push(seen);
      const original = store.putLocked.bind(store);
      store.putLocked = async (input) => {
        const outcome = await original(input);
        objects.set(input.key, store.objects.get(input.key)!);
        seen.push(input.key);
        if (seen.length === crashAt) throw new Error('worker killed');
        return outcome;
      };
      return store;
    };
    const sleeps: number[] = [];
    const resumeDeps = (store: ArchiveStore) => deps(store, { partRows: 2, rowsPerSecond: 1, sleep: async (ms: number) => void sleeps.push(ms) });
    const key = (account: string | null, part: number) => `audit/${account ?? '_none'}/${w5.slice(0, 4)}/${w5}.00${part}.jsonl.gz`;

    // Run 1 dies in the middle of A1: only A1 .000 is recorded.
    await expect(exportWeek(resumeDeps(run(2)), w5)).rejects.toThrow('worker killed');
    const tally = (await q(`SELECT legacy_tally FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w5])).rows[0].legacy_tally;
    expect(tally).toMatchObject({ rows: '9', accounts: [A1, A3, null] });
    const recorded = async () =>
      (await q(`SELECT object_key, account_done FROM kortix.audit_archive_parts WHERE week_start = $1 ORDER BY object_key`, [w5])).rows
        .map((r) => `${r.object_key}${r.account_done ? ' done' : ''}`);
    expect(await recorded()).toEqual([key(A1, 0)]);

    // Run 2 continues A1 at its second part and dies after A3 .000 is uploaded but before it is recorded.
    await expect(exportWeek(resumeDeps(run(4)), w5)).rejects.toThrow('worker killed');
    expect(puts[1]).toEqual([key(A1, 1), key(A1, 2), key(A3, 0), key(A3, 1)]);
    expect(await recorded()).toEqual([key(A1, 0), key(A1, 1), `${key(A1, 2)} done`, key(A3, 0)]);

    // Run 3 skips A1, continues A3 after .000, and reads only the 2 rows left: A3's third and _none's.
    sleeps.length = 0;
    const resumed = await exportWeek(resumeDeps(run(null)), w5);
    expect(resumed).toMatchObject({ rows: 9, legacyRows: 9, objects: 6 });
    expect(puts[2]).toEqual([key(A3, 1), key(null, 0), `audit/_manifest/${w5}.json`]);
    // Rate cap at 1 row/s: this run read 2 rows (owes at most 2 s). Reading the tally again would add
    // 9 s, and reading A1 or A3's first part again 5 s or 2 s.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(2_000);
    expect(await recorded()).toEqual([]); // progress rows go once the week is archived
    expect((await q(`SELECT status, legacy_tally FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w5])).rows[0]).toEqual({ status: 'archived', legacy_tally: null });

    // An uninterrupted export of the same week writes the same objects and the same manifest.
    await q(`UPDATE kortix.audit_archive_chunks SET status = 'exporting' WHERE week_start = $1`, [w5]);
    const clean = fakeStore();
    const whole = await exportWeek(deps(clean, { partRows: 2 }), w5);
    expect(whole.manifestSha256).toBe(resumed.manifestSha256);
    expect([...clean.objects.keys()].sort()).toEqual([...objects.keys()].filter((k) => k.includes(`/${w5}.`)).sort());
    for (const [k, object] of clean.objects) expect(Buffer.compare(object.body, objects.get(k)!.body)).toBe(0);
  });

  test('an export that reaches its deadline stops between pages with its progress saved, and the next run finishes the week', async () => {
    const w6 = weekStartOf(new Date(Date.now() - 140 * DAY));
    await seed(A3, 'partition.w6', new Date(new Date(`${w6}T00:00:00Z`).getTime() + DAY).toISOString(), 7);
    const store = fakeStore();
    let checks = 0;
    // The clock passes the deadline at the third check: two pages of 3 rows are read (one part of 4 is recorded).
    const clock = () => (++checks >= 3 ? 2 : 0);
    const paused = await exportWeek(deps(store, { partRows: 4, clock }), w6, 1);
    expect(paused).toBeNull();
    const parts = await q(`SELECT object_key, row_count FROM kortix.audit_archive_parts WHERE week_start = $1`, [w6]);
    expect(parts.rows).toEqual([{ object_key: `audit/${A3}/${w6.slice(0, 4)}/${w6}.000.jsonl.gz`, row_count: 4 }]);
    expect((await q(`SELECT status FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w6])).rows[0].status).toBe('exporting');
    const done = await exportWeek(deps(store, { partRows: 4 }), w6);
    expect(done).toMatchObject({ rows: 7, objects: 2 });
  });

  test('a pass waits for the activity rollup: a week it has not counted stays in PostgreSQL', async () => {
    const before = (await q(`SELECT rolled_through FROM kortix.audit_activity_rollup WHERE id = 1`)).rows[0]?.rolled_through ?? null;
    await q(
      `INSERT INTO kortix.audit_activity_rollup (id, rolled_through) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET rolled_through = EXCLUDED.rolled_through`,
      [`${w1}T00:00:00Z`],
    );
    try {
      const result = await runArchivePass(deps(fakeStore()), Date.now() + 120_000);
      // Only weeks that end at or before the rollup mark (empty partitions here) may go.
      const mark = new Date(`${w1}T00:00:00Z`).getTime();
      expect(result.archived.every((week) => weekEnd(week).getTime() <= mark)).toBe(true);
      expect(result.archived).not.toContain(w1);
      expect(result.legacyRetired).toBe(false);
      expect(result.removed).toEqual([]);
      expect((await q(`SELECT status FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w1])).rows).toHaveLength(0);
    } finally {
      if (before) await q(`UPDATE kortix.audit_activity_rollup SET rolled_through = $1 WHERE id = 1`, [before]);
      else await q(`DELETE FROM kortix.audit_activity_rollup WHERE id = 1`);
    }
  });

  test('a pass archives every old week, retires the legacy table, and drops the archived partitions', async () => {
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.archived).toEqual(expect.arrayContaining([w1, w2]));
    expect(result.legacyRetired).toBe(true);
    // Renamed inside the retirement transaction, dropped right after it.
    expect((await q(`SELECT to_regclass('kortix.audit_events_legacy_retired') AS r`)).rows[0].r).toBeNull();

    // w3 (5 rows) was archived by an earlier test with its own store. This pass wrote the rest:
    // 8 + 1 + 1 legacy rows and 2 late rows.
    let archived = 0;
    for (const [key, object] of store.objects) {
      if (key.includes('_manifest')) continue;
      archived += decodeRows(object.body).length;
    }
    expect(archived).toBe(8 + 1 + 1 + 2);
    expect([...store.objects.keys()].some((k) => k.startsWith('audit/_none/'))).toBe(true);

    // PostgreSQL: the legacy table and the old partitions are gone, the hot rows remain.
    expect((await q(`SELECT to_regclass('kortix.audit_events_legacy') AS r`)).rows[0].r).toBeNull();
    expect((await q(`SELECT to_regclass('kortix.audit_events_p${w1.replaceAll('-', '')}') AS r`)).rows[0].r).toBeNull();
    const view = await q(`SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE account_id = ANY($1::uuid[])`, [[A1, A2]]);
    expect(view.rows[0].n).toBe(3);
    const statuses = await q(`SELECT DISTINCT status FROM kortix.audit_archive_chunks WHERE week_start = ANY($1::date[])`, [[w1, w2, w3]]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['removed']);

    // The week the partition path removes (w3) and a rerun do nothing more.
    const again = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(again).toEqual({ archived: [], removed: [], expired: [], legacyRetired: false, pending: false });
  });

  test('after the legacy table is gone, a pass archives a partition week and then drops it (detach, recount, drop)', async () => {
    const w4 = weekStartOf(new Date(Date.now() - 120 * DAY));
    // The earlier pass already archived and dropped this (empty) week; bring it back with 4 rows.
    await q(`DELETE FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w4]);
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 125, 0)`);
    await seed(A2, 'partition.w4', daysAgo(120), 4);
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.archived).toContain(w4);
    expect(result.removed).toContain(w4);
    expect((await q(`SELECT to_regclass('kortix.audit_events_p${w4.replaceAll('-', '')}') AS r`)).rows[0].r).toBeNull();
    const gone = await q(`SELECT count(*)::int AS n FROM kortix.audit_events_all WHERE action = 'partition.w4'`);
    expect(gone.rows[0].n).toBe(0); // served from the archive now
    const archived = [...store.objects].filter(([k]) => k.includes(`/${w4}.0`)).flatMap(([, o]) => decodeRows(o.body));
    expect(archived).toHaveLength(4);
  });

  test('a week past the 365-day retention that was never exported is dropped, not exported', async () => {
    const old = weekStartOf(new Date(Date.now() - 400 * DAY));
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 410, 0)`);
    const store = fakeStore();
    const result = await runArchivePass(deps(store), Date.now() + 120_000);
    expect(result.expired).toContain(old);
    expect([...store.objects.keys()].some((k) => k.includes(old))).toBe(false);
    expect(weekEnd(old).getTime()).toBeLessThan(Date.now() - 365 * DAY + DAY * 7);
  });
  test('a pass that runs out of budget mid-week reports pending, and the next pass finishes and removes the week', async () => {
    const w7 = weekStartOf(new Date(Date.now() - 110 * DAY));
    // An earlier pass archived and dropped this week while it was empty; bring it back with 5 rows.
    await q(`DELETE FROM kortix.audit_archive_chunks WHERE week_start = $1`, [w7]);
    await q(`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date - 115, 0)`);
    await seed(A3, 'partition.w7', new Date(new Date(`${w7}T00:00:00Z`).getTime() + DAY).toISOString(), 5);
    const store = fakeStore();
    // The budget runs out once w7's first part is in the bucket.
    const clock = () => ([...store.objects.keys()].some((k) => k.includes(`/${w7}.`)) ? 1 : 0);
    const paused = await runArchivePass(deps(store, { partRows: 2, clock }), 0.5);
    expect(paused.pending).toBe(true);
    expect(paused.archived).not.toContain(w7);
    expect((await q(`SELECT count(*)::int AS n FROM kortix.audit_archive_parts WHERE week_start = $1`, [w7])).rows[0].n).toBe(1);
    const next = await runArchivePass(deps(store, { partRows: 2 }), Date.now() + 120_000);
    expect(next).toMatchObject({ pending: false });
    expect(next.archived).toContain(w7);
    expect(next.removed).toContain(w7);
    const archived = [...store.objects].filter(([k]) => k.includes(`/${w7}.0`)).flatMap(([, o]) => decodeRows(o.body));
    expect(archived).toHaveLength(5);
  });
});
