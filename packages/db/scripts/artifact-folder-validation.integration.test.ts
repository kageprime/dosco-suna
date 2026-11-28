import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';
import { up as buildIndex } from '../migrations/20261123220747725_artifact_folder_index.concurrent';

// An explicit test DB is required. Every object lives in a unique temporary schema.
test.skipIf(!process.env.DATABASE_URL)('folder FK validation releases the expansion lock before scanning', async () => {
  const schema = `artifact_folder_probe_${crypto.randomUUID().replaceAll('-', '')}`;
  const writer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const reader = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const runtime = materializeMigrationRuntimeDirectory(join(import.meta.dir, '../migrations'));
  await writer.connect();
  await reader.connect();
  try {
    await writer.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.projects(project_id uuid PRIMARY KEY);
      CREATE TABLE ${schema}.workspaces(workspace_id uuid PRIMARY KEY);
      CREATE TABLE ${schema}.artifacts(artifact_id uuid PRIMARY KEY);
      INSERT INTO ${schema}.artifacts SELECT gen_random_uuid() FROM generate_series(1, 200)`);
    const expansion = readFileSync(join(runtime.path, '20261123215124149_artifact_folders.sql'), 'utf8');
    await writer.query('BEGIN');
    await writer.query(expansion.replaceAll('kortix', schema));
    await writer.query('COMMIT');
    const constraint = () => writer.query(`SELECT convalidated FROM pg_constraint
      WHERE conrelid='${schema}.artifacts'::regclass AND contype='f'`);
    expect((await constraint()).rows[0].convalidated).toBe(false);
    const statements: string[] = [];
    buildIndex({ noTransaction() {}, sql(statement: string) { statements.push(statement); } });
    for (const statement of statements) await writer.query(statement.replaceAll('kortix', schema));
    const validation = readFileSync(join(import.meta.dir, '../migrations/20261123230000000_validate_artifact_folder_membership.sql'), 'utf8');
    await writer.query('BEGIN');
    await writer.query(validation.replaceAll('kortix', schema));
    const locks = await writer.query(`SELECT mode FROM pg_locks WHERE pid=pg_backend_pid()
      AND relation='${schema}.artifacts'::regclass`);
    expect(locks.rows.map(row => row.mode)).not.toContain('AccessExclusiveLock');
    await reader.query("SET statement_timeout='1s'");
    expect((await reader.query(`SELECT count(*)::int AS count FROM ${schema}.artifacts`)).rows[0].count).toBe(200);
    await writer.query('COMMIT');
    expect((await constraint()).rows[0].convalidated).toBe(true);
  } finally {
    await writer.query('ROLLBACK');
    await writer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    runtime.cleanup();
    await writer.end();
    await reader.end();
  }
});
