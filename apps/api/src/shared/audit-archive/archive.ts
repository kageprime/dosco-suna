/**
 * The audit archive job: export a week of `kortix.audit_events` to S3, verify it, then remove it
 * from PostgreSQL.
 *
 * Why: the table is partitioned by week and keeps HOT_DAYS (format.ts) in PostgreSQL. Older
 * history is evidence the product owes for 365 days (privacy policy), so it moves to an Object
 * Lock bucket (tamper evidence: COMPLIANCE retention until the week's end + 365 days) instead of
 * staying in a 2 TB btree. Order of a week, each step safe to repeat:
 *   1. export  one account at a time, rows ascending by (occurred_at, event_id), at most ARCHIVE_PART_ROWS per
 *              object, written once (If-None-Match) with Object Lock; S3 verifies each SHA-256;
 *   2. verify  count and an order-free checksum of event ids, streamed vs. a second read;
 *   3. record  `audit_archive_chunks.status = archived` (PostgreSQL still serves the week);
 *   4. remove  DETACH + DROP the partition after re-counting it; status removed. DETACH takes
 *              ACCESS EXCLUSIVE on the parent for an instant (DETACH ... CONCURRENTLY is refused
 *              while the table has a default partition), so it runs under a 1 s lock_timeout and
 *              retries; one partition a week.
 * The pre-partitioning table (audit_events_legacy) cannot lose rows one by one (145M deletes is a
 * WAL storm), so it is exported week by week and dropped whole, once every row is older than
 * HOT_DAYS (`retireLegacy`).
 *
 * Bounded IO (prod: 125 MiB/s of disk throughput for everything). Every read that touches table
 * rows is capped at `rowsPerSecond`:
 *   - export pages are keyset batches of `batchRows` (5,000), each branch ordered and limited on
 *     its own (account_id, occurred_at) index, so a page reads ~batchRows rows. A UNION ALL with
 *     one outer ORDER BY ... LIMIT planned a parallel seq scan of the whole partition per page
 *     for an account that owns half of a week (prod EXPLAIN, 2026-11-10);
 *   - the legacy table's share of a week (the account list, the count, the checksum) is read in
 *     15-minute slices of its occurred_at index, not in one statement: one prod week holds ~50M
 *     legacy rows (~72 GB of heap);
 *   - a partition's account list and checksum are index-only scans (1.5-1.8 GB for a 40M-row week).
 * One week at a time, within `budgetMs` (3 h) per tick.
 */
import type { Database } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';
import type { ObjectLockMode } from '../../object-store/s3';
import {
  ARCHIVE_PART_ROWS,
  HOT_DAYS,
  archiveObjectKey,
  encodeRows,
  isExpired,
  isReadyToArchive,
  manifestKey,
  retainUntil,
  weekEnd,
} from './format';

export interface ArchiveStore {
  putLocked(input: { key: string; body: Buffer; contentType: string; retainUntil: Date; mode: ObjectLockMode }): Promise<'created' | 'exists'>;
  checksum(key: string): Promise<string | null>;
}

type Db = Pick<Database, 'execute' | 'transaction'>;

export interface ArchiveDeps {
  db: Db;
  store: ArchiveStore;
  mode: ObjectLockMode;
  rowsPerSecond: number;
  batchRows?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

const DAY_MS = 86_400_000;
/** One statement of the legacy tally reads this much of the week (~0.1-0.4 GB on prod's busiest week). */
const LEGACY_SLICE_MS = 15 * 60_000;
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const rows = <T>(result: unknown): T[] => Array.from(result as Iterable<T>);
/** A SQL date[] literal: drizzle expands a JS array into a row, which PostgreSQL cannot cast. */
const dateArray = (weeks: string[]) =>
  weeks.length ? sql`ARRAY[${sql.join(weeks.map((w) => sql`${w}::date`), sql`, `)}]::date[]` : sql`ARRAY[]::date[]`;
const base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

function assertWeek(week: string): string {
  if (!WEEK_RE.test(week)) throw new Error(`invalid week ${week}`);
  return week;
}
const partitionName = (week: string) => `audit_events_p${assertWeek(week).replaceAll('-', '')}`;

/** Read-only statements that scan a week need minutes, not the pool's seconds. */
async function longRead<T>(db: Db, run: (tx: Pick<Database, 'execute'>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30min'`);
    return run(tx);
  });
}

async function legacyExists(db: Db): Promise<boolean> {
  const [r] = rows<{ present: boolean }>(await db.execute(sql`SELECT to_regclass('kortix.audit_events_legacy') IS NOT NULL AS present`));
  return Boolean(r?.present);
}

/**
 * The weeks the legacy table covers, oldest first: one probe of its occurred_at index per week
 * (a loose index scan), not a DISTINCT over every row (a 4 GB index read on prod).
 */
async function legacyWeekList(db: Db): Promise<string[]> {
  return rows<{ w: string }>(
    await db.execute(sql`
      WITH RECURSIVE w(t) AS (
        SELECT date_trunc('week', min(occurred_at) AT TIME ZONE 'UTC') FROM kortix.audit_events_legacy
        UNION ALL
        SELECT (SELECT date_trunc('week', min(l.occurred_at) AT TIME ZONE 'UTC') FROM kortix.audit_events_legacy l
                 WHERE l.occurred_at >= (w.t + interval '7 days') AT TIME ZONE 'UTC')
          FROM w WHERE w.t IS NOT NULL)
      SELECT to_char(t, 'YYYY-MM-DD') AS w FROM w WHERE t IS NOT NULL`),
  ).map((r) => r.w);
}

async function partitionAttached(db: Db, week: string): Promise<boolean> {
  const [r] = rows<{ present: boolean }>(
    await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'kortix.audit_events'::regclass AND c.relname = ${partitionName(week)}) AS present`),
  );
  return Boolean(r?.present);
}

const weekBounds = (week: string) => ({
  lo: `${assertWeek(week)} 00:00:00+00`,
  hi: `${weekEnd(week).toISOString().slice(0, 10)} 00:00:00+00`,
});

const partitionRows = (week: string, where: SQL) =>
  sql`SELECT * FROM ${sql.raw(`kortix.${partitionName(week)}`)} WHERE ${where}`;

const legacyRows = (week: string, where: SQL) => {
  const { lo, hi } = weekBounds(week);
  return sql`SELECT * FROM kortix.audit_events_legacy WHERE occurred_at >= ${lo}::timestamptz AND occurred_at < ${hi}::timestamptz AND ${where}`;
};

const CHK = sql.raw(`(('x' || substr(md5(s.event_id::text), 1, 15))::bit(60)::bigint)`);

interface ExportRow {
  line: string;
  account_id: string | null;
  at: string;
  id: string;
  chk: string;
}

export interface ManifestObject {
  key: string;
  account_id: string | null;
  part: number;
  rows: number;
  bytes: number;
  sha256: string;
  first_occurred_at: string;
  last_occurred_at: string;
}

export interface WeekExport {
  week: string;
  rows: number;
  legacyRows: number;
  objects: number;
  bytes: number;
  manifestKey: string;
  manifestSha256: string;
}

interface Tally {
  rows: bigint;
  sum: bigint;
  accounts: Set<string | null>;
}

/** Sleeps off what `read` rows owe at `rowsPerSecond`, measured from `startedAt`. */
function rateCap(deps: ArchiveDeps, startedAt: number) {
  const sleep = deps.sleep ?? Bun.sleep;
  let read = 0;
  return async (rowsRead: number) => {
    read += rowsRead;
    const owedMs = (read / deps.rowsPerSecond) * 1000 - (Date.now() - startedAt);
    if (owedMs > 5) await sleep(owedMs);
  };
}

/**
 * The legacy table's share of `week`: its accounts, row count and event-id checksum, read in
 * LEGACY_SLICE_MS slices of the occurred_at index under the rate cap. The legacy table takes no
 * writes, so a tally taken before the export verifies it as well as one taken after.
 */
async function legacyTally(deps: ArchiveDeps, week: string, pace: (rows: number) => Promise<void>): Promise<Tally> {
  const tally: Tally = { rows: 0n, sum: 0n, accounts: new Set() };
  const { lo, hi } = weekBounds(week);
  const [any] = rows<{ present: boolean }>(
    await deps.db.execute(sql`SELECT EXISTS (SELECT 1 FROM kortix.audit_events_legacy
                                              WHERE occurred_at >= ${lo}::timestamptz AND occurred_at < ${hi}::timestamptz) AS present`),
  );
  if (!any?.present) return tally;
  const end = weekEnd(week).getTime();
  for (let from = new Date(`${week}T00:00:00Z`).getTime(); from < end; from += LEGACY_SLICE_MS) {
    const to = Math.min(from + LEGACY_SLICE_MS, end);
    const slice = rows<{ account_id: string | null; n: string; sum: string }>(
      await deps.db.execute(sql`
        SELECT s.account_id::text AS account_id, count(*)::text AS n, coalesce(sum(${CHK}), 0)::text AS sum
          FROM kortix.audit_events_legacy s
         WHERE s.occurred_at >= ${new Date(from).toISOString()}::timestamptz AND s.occurred_at < ${new Date(to).toISOString()}::timestamptz
         GROUP BY 1`),
    );
    let sliceRows = 0;
    for (const r of slice) {
      tally.accounts.add(r.account_id);
      tally.rows += BigInt(r.n);
      tally.sum += BigInt(r.sum);
      sliceRows += Number(r.n);
    }
    await pace(sliceRows);
  }
  return tally;
}

/** Ascending account ids, NULL last (the order `ORDER BY account_id::text` gives). */
const accountOrder = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

export async function exportWeek(deps: ArchiveDeps, week: string): Promise<WeekExport> {
  const { db, store, mode } = deps;
  const batch = deps.batchRows ?? 5_000;
  const keepUntil = retainUntil(week);
  const partition = await partitionAttached(db, week);
  const legacy = await legacyExists(db);

  await db.execute(sql`
    INSERT INTO kortix.audit_archive_chunks (week_start, status, retain_until)
    VALUES (${week}::date, 'exporting', ${keepUntil.toISOString()}::timestamptz)
    ON CONFLICT (week_start) DO UPDATE SET status = 'exporting', retain_until = EXCLUDED.retain_until, updated_at = now()`);

  const startedAt = Date.now();
  const pace = rateCap(deps, startedAt);
  const legacyShare = legacy ? await legacyTally(deps, week, pace) : { rows: 0n, sum: 0n, accounts: new Set<string | null>() };
  const withLegacy = legacyShare.rows > 0n;

  const objects: ManifestObject[] = [];
  let totalRows = 0;
  let totalBytes = 0;
  let checksumSum = 0n;
  let current: { account: string | null; part: number; lines: string[]; first: string; last: string } | null = null;

  const flush = async () => {
    if (!current || current.lines.length === 0) return;
    const encoded = encodeRows(current.lines);
    const key = archiveObjectKey(current.account, week, current.part);
    await store.putLocked({ key, body: encoded.bytes, contentType: 'application/gzip', retainUntil: keepUntil, mode });
    // Whether created now or by an earlier attempt, S3 must hold exactly these bytes.
    if ((await store.checksum(key)) !== base64(encoded.sha256)) {
      throw new Error(`archive object ${key} does not match the exported rows (S3 checksum differs)`);
    }
    objects.push({
      key, account_id: current.account, part: current.part, rows: encoded.rows,
      bytes: encoded.bytes.length, sha256: encoded.sha256, first_occurred_at: current.first, last_occurred_at: current.last,
    });
    totalBytes += encoded.bytes.length;
    current = { ...current, part: current.part + 1, lines: [], first: '', last: '' };
  };

  const take = async (page: ExportRow[]) => {
    for (const row of page) {
      if (current && (current.account !== row.account_id || current.lines.length >= ARCHIVE_PART_ROWS)) {
        const sameAccount = current.account === row.account_id;
        await flush();
        if (!sameAccount) current = null;
      }
      current ??= { account: row.account_id, part: 0, lines: [], first: '', last: '' };
      if (current.lines.length === 0) current.first = row.at;
      current.lines.push(row.line);
      current.last = row.at;
      totalRows += 1;
      checksumSum += BigInt(row.chk);
    }
  };

  // One account at a time: its rows are one index range, already in (occurred_at, event_id) order.
  // The partition's accounts come from an index-only scan of (account_id, occurred_at).
  const accountSet = new Set(legacyShare.accounts);
  if (partition) {
    const listed = rows<{ account_id: string | null }>(
      await longRead(db, (tx) => tx.execute(sql`SELECT DISTINCT s.account_id::text AS account_id FROM (${partitionRows(week, sql`true`)}) s`)),
    );
    for (const r of listed) accountSet.add(r.account_id);
  }
  const accounts = [...accountSet].sort(accountOrder);
  for (const account of accounts) {
    const accountWhere = account === null ? sql`account_id IS NULL` : sql`account_id = ${account}::uuid`;
    let cursor = null as { at: string; id: string } | null;
    for (;;) {
      const where = cursor
        ? sql`${accountWhere} AND (occurred_at, event_id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : accountWhere;
      // Each branch is ordered and limited by itself, so each reads at most `batch` rows from its index.
      const branches: SQL[] = [];
      if (partition) branches.push(sql`(${partitionRows(week, where)} ORDER BY occurred_at, event_id LIMIT ${batch})`);
      if (withLegacy) branches.push(sql`(${legacyRows(week, where)} ORDER BY occurred_at, event_id LIMIT ${batch})`);
      if (branches.length === 0) break;
      const page: ExportRow[] = rows<ExportRow>(
        await db.execute(sql`
          -- occurred_at as fixed-width UTC microseconds: to_jsonb would print it in the session time zone.
          SELECT (to_jsonb(s) || jsonb_build_object('occurred_at', to_char(s.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text AS line,
                 s.account_id::text AS account_id, s.occurred_at::text AS at,
                 s.event_id::text AS id, ${CHK}::text AS chk
            FROM (${sql.join(branches, sql` UNION ALL `)}) s
           ORDER BY s.occurred_at, s.event_id
           LIMIT ${batch}`),
      );
      if (page.length === 0) break;
      await take(page);
      const last: ExportRow = page[page.length - 1]!;
      cursor = { at: last.at, id: last.id };
      // Rate cap: rows read so far may not outrun rowsPerSecond. Sleep off what is owed, in lumps.
      await pace(page.length);
      if (page.length < batch) break;
    }
  }
  await flush();

  // The partition takes late writes, so its half of the check reads it again after the export
  // (an index-only scan of its primary key).
  const [partitionCheck] = partition
    ? rows<{ n: string; sum: string }>(
        await longRead(db, (tx) =>
          tx.execute(sql`SELECT count(*)::text AS n, coalesce(sum(${CHK}), 0)::text AS sum FROM (${partitionRows(week, sql`true`)}) s`),
        ),
      )
    : [{ n: '0', sum: '0' }];
  const expectedRows = BigInt(partitionCheck?.n ?? '0') + legacyShare.rows;
  const expectedSum = BigInt(partitionCheck?.sum ?? '0') + legacyShare.sum;
  if (expectedRows !== BigInt(totalRows) || expectedSum !== checksumSum) {
    throw new Error(`export of ${week} does not match PostgreSQL: streamed ${totalRows} rows, database has ${expectedRows}`);
  }
  const legacyCount = Number(legacyShare.rows);

  const manifest = JSON.stringify({
    version: 1, week_start: week, week_end: weekEnd(week).toISOString(), rows: totalRows,
    legacy_rows: legacyCount, event_id_checksum: checksumSum.toString(),
    objects: objects.sort((a, b) => (a.key < b.key ? -1 : 1)),
  });
  const encodedManifest = Buffer.from(manifest);
  const manifestHash = (await import('node:crypto')).createHash('sha256').update(encodedManifest).digest('hex');
  const mKey = manifestKey(week);
  await store.putLocked({ key: mKey, body: encodedManifest, contentType: 'application/json', retainUntil: keepUntil, mode });
  if ((await store.checksum(mKey)) !== base64(manifestHash)) throw new Error(`manifest ${mKey} does not match`);

  await db.execute(sql`
    UPDATE kortix.audit_archive_chunks
       SET status = 'archived', row_count = ${totalRows}, legacy_row_count = ${legacyCount},
           object_count = ${objects.length}, byte_count = ${totalBytes}, manifest_key = ${mKey},
           manifest_sha256 = ${manifestHash}, archived_at = now(), updated_at = now()
     WHERE week_start = ${week}::date`);
  return { week, rows: totalRows, legacyRows: legacyCount, objects: objects.length, bytes: totalBytes, manifestKey: mKey, manifestSha256: manifestHash };
}

/** Partition weeks of `kortix.audit_events` (the attached ones), oldest first, as `yyyy-mm-dd`. */
async function attachedWeeks(db: Db): Promise<string[]> {
  return rows<{ name: string }>(
    await db.execute(sql`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'kortix.audit_events'::regclass AND c.relname ~ '^audit_events_p[0-9]{8}$'
       ORDER BY c.relname`),
  ).map((r) => `${r.name.slice(-8, -4)}-${r.name.slice(-4, -2)}-${r.name.slice(-2)}`);
}

async function chunkStatus(db: Db, week: string): Promise<{ status: string; rowCount: number; legacyRowCount: number } | null> {
  const [r] = rows<{ status: string; rowCount: string; legacyRowCount: string }>(
    await db.execute(sql`SELECT status, row_count::text AS "rowCount", legacy_row_count::text AS "legacyRowCount"
                           FROM kortix.audit_archive_chunks WHERE week_start = ${week}::date`),
  );
  return r ? { status: r.status, rowCount: Number(r.rowCount), legacyRowCount: Number(r.legacyRowCount) } : null;
}

async function countPartition(db: Db, week: string): Promise<number> {
  const [r] = rows<{ n: string }>(
    await longRead(db, (tx) => tx.execute(sql`SELECT count(*)::text AS n FROM ${sql.raw(`kortix.${partitionName(week)}`)}`)),
  );
  return Number(r?.n ?? 0);
}

/**
 * How far the activity rollup (`kortix.audit_activity_rollup`, shared/audit-activity.ts) has
 * counted raw rows. It reads PostgreSQL only: a week removed before it is counted is a permanent
 * gap in "who was active". null = the rollup has not started; its first run reads only HOT_DAYS.
 */
async function rollupMark(db: Db): Promise<Date | null> {
  const [r] = rows<{ at: string | null }>(
    await db.execute(sql`SELECT (SELECT rolled_through::text FROM kortix.audit_activity_rollup WHERE id = 1) AS at`),
  );
  return r?.at ? new Date(r.at) : null;
}

/** DETACH takes ACCESS EXCLUSIVE on the parent: never wait for it longer than a second, and retry. */
async function detachPartition(deps: ArchiveDeps, week: string): Promise<void> {
  const sleep = deps.sleep ?? Bun.sleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(sql.raw(`ALTER TABLE kortix.audit_events DETACH PARTITION kortix.${partitionName(week)}`));
      });
      return;
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
      if (code !== '55P03' || attempt >= 5) throw error;
      await sleep(2_000 * attempt);
    }
  }
}

/** Detach and drop one archived partition, after proving it still holds what was exported. */
async function removePartition(deps: ArchiveDeps, week: string, expectedRows: number): Promise<void> {
  const { db } = deps;
  const name = partitionName(week);
  if (await partitionAttached(db, week)) await detachPartition(deps, week);
  const held = await countPartition(db, week);
  if (held !== expectedRows) {
    // Rows arrived after the export. They are still in the detached table: keep it for an operator.
    deps.log?.('archive: detached partition holds rows that were not exported; NOT dropped', { week, held, expectedRows });
    throw new Error(`partition ${name} holds ${held} rows, archive has ${expectedRows}`);
  }
  await db.execute(sql.raw(`DROP TABLE kortix.${name}`));
  await db.execute(sql`UPDATE kortix.audit_archive_chunks SET status = 'removed', removed_at = now(), updated_at = now() WHERE week_start = ${week}::date`);
}

export interface TickResult {
  archived: string[];
  removed: string[];
  expired: string[];
  legacyRetired: boolean;
}

/** Name the legacy table takes in the retirement transaction; dropped right after it commits. */
const RETIRED_LEGACY = 'audit_events_legacy_retired';

/**
 * One pass. Weeks are processed oldest first and the pass stops at `deadline`; whatever is left
 * runs on the next tick. Partitions are removed only once the legacy table is gone: a week's
 * legacy rows are exported with it, but cannot be deleted one by one (see the file header).
 */
export async function runArchivePass(deps: ArchiveDeps, deadline: number): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const result: TickResult = { archived: [], removed: [], expired: [], legacyRetired: false };
  // A retirement that committed but did not get to drop the renamed table (see retireLegacy).
  await deps.db.execute(sql.raw(`DROP TABLE IF EXISTS kortix.${RETIRED_LEGACY}`));
  const legacy = await legacyExists(deps.db);
  const weeks = new Set(await attachedWeeks(deps.db));
  if (legacy) for (const w of await legacyWeekList(deps.db)) weeks.add(w);
  const rolledThrough = await rollupMark(deps.db);
  let waitingForRollup = false;
  for (const week of [...weeks].sort()) {
    if (Date.now() > deadline) return result;
    if (!isReadyToArchive(week, now())) continue;
    const chunk = await chunkStatus(deps.db, week);
    if (isExpired(week, now()) && chunk?.status !== 'archived' && chunk?.status !== 'removed') {
      // Past the 365-day retention without an export: retention wins, the data is dropped.
      if (!legacy && (await partitionAttached(deps.db, week))) {
        deps.log?.('archive: week is past retention and was never exported; dropping', { week });
        await detachPartition(deps, week);
        await deps.db.execute(sql.raw(`DROP TABLE kortix.${partitionName(week)}`));
        await deps.db.execute(sql`INSERT INTO kortix.audit_archive_chunks (week_start, status, updated_at) VALUES (${week}::date, 'expired', now())
                                  ON CONFLICT (week_start) DO UPDATE SET status = 'expired', updated_at = now()`);
        result.expired.push(week);
      }
      continue;
    }
    if (chunk?.status !== 'archived' && chunk?.status !== 'removed') {
      // The rollup has not counted this week yet: removing it would lose its activity for good.
      if (rolledThrough && weekEnd(week).getTime() > rolledThrough.getTime()) {
        waitingForRollup = true;
        continue;
      }
      await exportWeek(deps, week);
      result.archived.push(week);
    }
  }
  if (waitingForRollup) {
    deps.log?.('archive: waiting for the activity rollup before archiving older weeks', { rolledThrough: rolledThrough?.toISOString() });
  }
  if (legacy) {
    result.legacyRetired = await retireLegacy(deps, now());
  }
  for (const week of await attachedWeeks(deps.db)) {
    if (Date.now() > deadline) break;
    const chunk = await chunkStatus(deps.db, week);
    if (chunk?.status === 'archived' && !(await legacyExists(deps.db))) {
      await removePartition(deps, week, chunk.rowCount - chunk.legacyRowCount);
      result.removed.push(week);
    }
  }
  return result;
}

/**
 * Drop the pre-partitioning table once every one of its rows is older than HOT_DAYS and every
 * week it covers is archived. The partitions of those weeks leave PostgreSQL in the same commit
 * as the legacy table: the export reads a week from S3 only once PostgreSQL holds none of it.
 * Later archived partitions are removed one by one after this (`removePartition`).
 *
 * The DETACHes take ACCESS EXCLUSIVE on `kortix.audit_events` until the commit, and every audit
 * write waits behind that lock. So the transaction holds no scan: the partitions are counted
 * before it (no writer adds a row older than LATE_ROW_MAX_AGE_DAYS, format.ts), and the legacy
 * table is renamed inside it and dropped after it, so unlinking ~200 GB of files is not done
 * under the lock. Returns false while any week is still pending.
 */
export async function retireLegacy(deps: ArchiveDeps, now: Date): Promise<boolean> {
  const { db } = deps;
  if (!(await legacyExists(db))) return false;
  const [bounds] = rows<{ newest: string | null }>(
    await db.execute(sql`SELECT max(occurred_at)::text AS newest FROM kortix.audit_events_legacy`),
  );
  if (bounds?.newest && new Date(bounds.newest).getTime() >= now.getTime() - HOT_DAYS * DAY_MS) return false;
  const legacyWeeks = await legacyWeekList(db);
  let archivedLegacyRows = 0;
  for (const week of legacyWeeks) {
    const chunk = await chunkStatus(db, week);
    if (chunk?.status !== 'archived') return false;
    archivedLegacyRows += chunk.legacyRowCount;
  }
  const [live] = rows<{ n: string }>(await longRead(db, (tx) => tx.execute(sql`SELECT count(*)::text AS n FROM kortix.audit_events_legacy`)));
  if (Number(live?.n ?? -1) !== archivedLegacyRows) {
    deps.log?.('archive: legacy table changed since the export; not dropping', { live: live?.n, archivedLegacyRows });
    return false;
  }
  // The partitions of the legacy weeks: their rows are archived with the week.
  const legacyWeekSet = new Set(legacyWeeks);
  const partitionWeeks: string[] = [];
  for (const week of await attachedWeeks(db)) {
    if (!legacyWeekSet.has(week) || !isReadyToArchive(week, now)) continue;
    const chunk = await chunkStatus(db, week);
    if (chunk?.status !== 'archived') continue;
    const held = await countPartition(db, week);
    if (held !== chunk.rowCount - chunk.legacyRowCount) throw new Error(`partition for ${week} changed since the export`);
    partitionWeeks.push(week);
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`CREATE OR REPLACE VIEW kortix.audit_events_all AS SELECT * FROM kortix.audit_events`);
    await tx.execute(sql.raw(`ALTER TABLE kortix.audit_events_legacy RENAME TO ${RETIRED_LEGACY}`));
    for (const week of partitionWeeks) {
      await tx.execute(sql.raw(`ALTER TABLE kortix.audit_events DETACH PARTITION kortix.${partitionName(week)}`));
      await tx.execute(sql.raw(`DROP TABLE kortix.${partitionName(week)}`));
    }
    await tx.execute(sql`UPDATE kortix.audit_archive_chunks SET status = 'removed', removed_at = now(), updated_at = now()
                          WHERE status = 'archived' AND (week_start = ANY(${dateArray(legacyWeeks)}) OR week_start = ANY(${dateArray(partitionWeeks)}))`);
  });
  await db.execute(sql.raw(`DROP TABLE IF EXISTS kortix.${RETIRED_LEGACY}`));
  return true;
}
