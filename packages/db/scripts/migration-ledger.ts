import type pg from 'pg';
import { withClient, withTransaction } from '../src/with-client';

/**
 * The one owner of the migration ledger: the table name and every row
 * operation on it. The repair planners (`migration-ledger-repair.ts`,
 * `local-audit-v2-ledger-repair.ts`, `early-applied-migration-repair.ts`)
 * stay pure functions over the rows this module reads.
 */
export const LEDGER_TABLE = 'kortix_migrations.pgmigrations';

export async function ledgerExists(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists ?? false;
}

/**
 * Applied migration names in ledger run order (`ORDER BY run_on, id`: the
 * order node-pg-migrate `up --check-order` compares).
 */
export async function ledgerNames(client: pg.Client): Promise<string[]> {
  const ledger = await client.query<{ name: string }>(`SELECT name FROM ${LEDGER_TABLE} ORDER BY run_on, id`);
  return ledger.rows.map((row) => row.name);
}

/** Whether the ledger has a row for `name`. */
export async function hasMigration(client: pg.Client, name: string): Promise<boolean> {
  const applied = await client.query(
    `select 1 from ${LEDGER_TABLE} where name = $1 limit 1`,
    [name],
  );
  return applied.rowCount === 1;
}

/**
 * Records `name` as applied now, but only when the ledger has no row for it
 * yet. Returns the affected row count (0 = the row already existed).
 */
export async function insertMigration(client: pg.Client, name: string): Promise<number | null> {
  const inserted = await client.query(
    `insert into ${LEDGER_TABLE} (name, run_on)
       select $1::varchar, clock_timestamp()
        where not exists (
          select 1 from ${LEDGER_TABLE} where name = $1::varchar
        )`,
    [name],
  );
  return inserted.rowCount;
}

export async function deleteMigration(client: pg.Client, name: string): Promise<number | null> {
  const deleted = await client.query(`delete from ${LEDGER_TABLE} where name = $1`, [name]);
  return deleted.rowCount;
}

/**
 * Renames `legacyName` to `currentName`, but only when no `currentName` row
 * exists yet. Returns the affected row count (0 = nothing renamed).
 */
export async function renameMigration(
  client: pg.Client,
  legacyName: string,
  currentName: string,
): Promise<number | null> {
  const result = await client.query(
    `update ${LEDGER_TABLE}
            set name = $2
          where name = $1
            and not exists (
              select 1
                from ${LEDGER_TABLE}
               where name = $2
            )`,
    [legacyName, currentName],
  );
  return result.rowCount;
}

/**
 * Moves `name`'s `run_on` one millisecond before `runOn`, so the row sorts
 * before the migration applied there.
 */
export async function reorderMigration(
  client: pg.Client,
  name: string,
  runOn: string,
): Promise<number | null> {
  const orderResult = await client.query(
    `update ${LEDGER_TABLE}
            set run_on = $2::timestamptz - interval '1 millisecond'
          where name = $1`,
    [name, runOn],
  );
  return orderResult.rowCount;
}

/**
 * Runs `fn` in one transaction that holds an exclusive lock on the migration
 * ledger. Returns `whenMissing` without opening a transaction when the ledger
 * table does not exist yet.
 */
export function withLedgerLock<T>(
  databaseUrl: string,
  whenMissing: T,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(databaseUrl, async (client) => {
    if (!(await ledgerExists(client))) return whenMissing;

    return withTransaction(client, async () => {
      await client.query(`lock table ${LEDGER_TABLE} in exclusive mode`);
      return fn(client);
    });
  });
}
