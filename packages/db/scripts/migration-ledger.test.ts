/**
 * Characterization pins for the migration ledger module.
 *
 * Every SQL string below was transcribed verbatim from the call sites that
 * held it before `migration-ledger.ts` existed (ledger-repair.ts,
 * migration-ledger-repair.ts, local-audit-v2-ledger-repair.ts,
 * early-applied-migration-repair.ts, catalog.ts, src/ledger-exists.ts at
 * trunk 14d2af0b1652). These modules run inside `pnpm migrate` on every
 * deploy, so the text and the parameters are pinned here: a change to the
 * ledger SQL must update this file in the same PR, never drift silently.
 */
import { describe, expect, test } from 'bun:test';
import type pg from 'pg';
import {
  LEDGER_TABLE,
  deleteMigration,
  hasMigration,
  insertMigration,
  ledgerExists,
  ledgerNames,
  reorderMigration,
  renameMigration,
} from './migration-ledger';

interface Recorded {
  sql: string;
  params: unknown[] | undefined;
}

/** A fake `pg.Client` that records every query and replays canned results. */
function recordingClient(results: Array<Partial<pg.QueryResult>> = []): {
  client: pg.Client;
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return results.shift() ?? { rowCount: 1, rows: [] };
    },
  } as unknown as pg.Client;
  return { client, queries };
}

describe('LEDGER_TABLE', () => {
  test('is the full qualified ledger name', () => {
    expect(LEDGER_TABLE).toBe('kortix_migrations.pgmigrations');
  });
});

describe('ledgerExists', () => {
  test('probes the ledger with to_regclass and reads the exists flag', async () => {
    const { client, queries } = recordingClient([{ rows: [{ exists: true }] }]);
    await expect(ledgerExists(client)).resolves.toBe(true);
    expect(queries).toEqual([
      { sql: "SELECT to_regclass('kortix_migrations.pgmigrations') IS NOT NULL AS exists", params: undefined },
    ]);
  });

  test('reads as false when no row comes back', async () => {
    const { client } = recordingClient([{ rows: [] }]);
    await expect(ledgerExists(client)).resolves.toBe(false);
  });
});

describe('ledgerNames', () => {
  test('selects the names in run_on, id order', async () => {
    const { client, queries } = recordingClient([
      { rows: [{ name: 'a' }, { name: 'b' }] },
    ]);
    await expect(ledgerNames(client)).resolves.toEqual(['a', 'b']);
    expect(queries).toEqual([
      { sql: 'SELECT name FROM kortix_migrations.pgmigrations ORDER BY run_on, id', params: undefined },
    ]);
  });
});

describe('hasMigration', () => {
  test('probes one name and reads the rowCount', async () => {
    const { client, queries } = recordingClient([{ rowCount: 1 }]);
    await expect(hasMigration(client, '20260807221200000_centralized_audit_v2')).resolves.toBe(true);
    expect(queries).toEqual([
      {
        sql: 'select 1 from kortix_migrations.pgmigrations where name = $1 limit 1',
        params: ['20260807221200000_centralized_audit_v2'],
      },
    ]);
  });

  test('reads as false when the row is missing', async () => {
    const { client } = recordingClient([{ rowCount: 0 }]);
    await expect(hasMigration(client, 'nope')).resolves.toBe(false);
  });
});

describe('insertMigration', () => {
  test('inserts if absent with clock_timestamp and returns the rowCount', async () => {
    const { client, queries } = recordingClient([{ rowCount: 1 }]);
    await expect(insertMigration(client, '20260807221200000_centralized_audit_v2')).resolves.toBe(1);
    expect(queries).toEqual([
      {
        sql:
          'insert into kortix_migrations.pgmigrations (name, run_on)\n' +
          '       select $1::varchar, clock_timestamp()\n' +
          '        where not exists (\n' +
          '          select 1 from kortix_migrations.pgmigrations where name = $1::varchar\n' +
          '        )',
        params: ['20260807221200000_centralized_audit_v2'],
      },
    ]);
  });

  test('returns 0 when the row already existed', async () => {
    const { client } = recordingClient([{ rowCount: 0 }]);
    await expect(insertMigration(client, 'already_there')).resolves.toBe(0);
  });
});

describe('deleteMigration', () => {
  test('deletes by name and returns the rowCount', async () => {
    const { client, queries } = recordingClient([{ rowCount: 1 }]);
    await expect(deleteMigration(client, '20260916150159063_session_list_keyset_index.concurrent')).resolves.toBe(1);
    expect(queries).toEqual([
      {
        sql: 'delete from kortix_migrations.pgmigrations where name = $1',
        params: ['20260916150159063_session_list_keyset_index.concurrent'],
      },
    ]);
  });
});

describe('renameMigration', () => {
  test('renames only when the target name is absent and returns the rowCount', async () => {
    const { client, queries } = recordingClient([{ rowCount: 1 }]);
    await expect(
      renameMigration(client, '20260729181733802_sandbox_deadline', '20260730000452547_sandbox_deadline'),
    ).resolves.toBe(1);
    expect(queries).toEqual([
      {
        sql:
          'update kortix_migrations.pgmigrations\n' +
          '            set name = $2\n' +
          '          where name = $1\n' +
          '            and not exists (\n' +
          '              select 1\n' +
          '                from kortix_migrations.pgmigrations\n' +
          '               where name = $2\n' +
          '            )',
        params: ['20260729181733802_sandbox_deadline', '20260730000452547_sandbox_deadline'],
      },
    ]);
  });

  test('returns 0 when nothing was renamed', async () => {
    const { client } = recordingClient([{ rowCount: 0 }]);
    await expect(renameMigration(client, 'a', 'b')).resolves.toBe(0);
  });
});

describe('reorderMigration', () => {
  test('moves run_on one millisecond before the given timestamp', async () => {
    const { client, queries } = recordingClient([{ rowCount: 1 }]);
    const runOn = new Date('2026-07-29T16:46:37.325Z').toISOString();
    await expect(
      reorderMigration(client, '20260729215216867_executor_policy_arg_conditions', runOn),
    ).resolves.toBe(1);
    expect(queries).toEqual([
      {
        sql:
          'update kortix_migrations.pgmigrations\n' +
          "            set run_on = $2::timestamptz - interval '1 millisecond'\n" +
          '          where name = $1',
        params: ['20260729215216867_executor_policy_arg_conditions', runOn],
      },
    ]);
  });

  test('returns 0 when the name is missing', async () => {
    const { client } = recordingClient([{ rowCount: 0 }]);
    await expect(reorderMigration(client, 'nope', '2026-07-29T16:46:37.325Z')).resolves.toBe(0);
  });
});
