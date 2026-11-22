/**
 * 20261120083000000 and 20261120094700000 both add
 * project_trigger_admissions_project_id_workspaces_fk. The committed second
 * file fails with 42710 after the first one. Its runtime copy
 * (migration-runtime-overrides.ts) must pass after the first file and still
 * add the constraint on a database where the first file did not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';
import { materializeMigrationRuntimeDirectory } from './migration-runtime-overrides';

const FIRST = '20261120083000000_trigger_admissions_workspace_twin.sql';
const SECOND = '20261120094700000_trigger_admissions_workspace_twin.sql';
const container = `kortix-twin-duplicate-${crypto.randomUUID().slice(0, 8)}`;

function psql(sql: string) {
  const result = Bun.spawnSync(
    ['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'testdb', '-v', 'ON_ERROR_STOP=1', '-t', '-A'],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

function apply(sql: string): void {
  const result = psql(sql);
  if (result.exitCode !== 0) throw new Error(result.output);
}

const SCHEMA = `
  DROP SCHEMA IF EXISTS kortix CASCADE;
  CREATE SCHEMA kortix;
  CREATE TABLE kortix.workspaces (workspace_id uuid PRIMARY KEY);
  CREATE TABLE kortix.project_trigger_admissions (
    admission_id uuid PRIMARY KEY,
    project_id uuid NOT NULL
  );
`;

/** `count|deferrable|deferred|validated` of the twin constraint. */
const TWIN = `
  SELECT count(*) || '|' || bool_and(condeferrable) || '|' || bool_and(condeferred) || '|' || bool_and(convalidated)
    FROM pg_constraint
   WHERE conrelid = 'kortix.project_trigger_admissions'::regclass
     AND conname = 'project_trigger_admissions_project_id_workspaces_fk'
     AND confrelid = 'kortix.workspaces'::regclass;
`;

describe.skipIf(!dockerAvailable)('duplicate trigger-admissions twin migration — real PostgreSQL', () => {
  const migrations = resolve(import.meta.dir, '..', 'migrations');
  let first = '';
  let committedSecond = '';
  let runtimeSecond = '';
  let cleanup = () => {};

  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker', 'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=testdb', 'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
      // Over TCP: the image's temporary initdb server listens on the socket only.
      ready = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'testdb', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      ).exitCode === 0;
      if (!ready) await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    const runtime = materializeMigrationRuntimeDirectory(migrations);
    cleanup = runtime.cleanup;
    expect(runtime.appliedOverrides.some((line) => line.startsWith(`${SECOND}:`))).toBe(true);
    first = readFileSync(resolve(migrations, FIRST), 'utf8');
    committedSecond = readFileSync(resolve(migrations, SECOND), 'utf8');
    runtimeSecond = readFileSync(resolve(runtime.path, SECOND), 'utf8');
  }, 30_000);

  beforeEach(() => apply(SCHEMA));

  afterAll(() => {
    cleanup();
    Bun.spawnSync(['docker', 'rm', '-f', '-v', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('the committed second file fails after the first one (the dev deploy failure)', () => {
    apply(first);
    const result = psql(committedSecond);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('already exists');
  });

  test('the runtime copy passes after the first file and keeps one deferred, unvalidated twin', () => {
    apply(first);
    apply(runtimeSecond);
    expect(psql(TWIN).output.trim()).toBe('1|true|true|false');
  });

  test('the runtime copy alone adds the twin where the first file did not run', () => {
    apply(runtimeSecond);
    expect(psql(TWIN).output.trim()).toBe('1|true|true|false');
  });

  test('the twin checks a missing workspace at commit, not at insert', () => {
    apply(first);
    apply(runtimeSecond);
    const result = psql(`
      BEGIN;
      INSERT INTO kortix.project_trigger_admissions VALUES
        ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-0000000000aa');
      SELECT 'inserted';
      COMMIT;
    `);
    expect(result.output).toContain('inserted');
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('project_trigger_admissions_project_id_workspaces_fk');
  });
});
