/**
 * Workspaces Release 2a (design.md §4 steps 4 and 1-prep), against the live
 * catalog of a freshly migrated database:
 *
 * - every foreign key into kortix.projects(project_id) has a twin on the same
 *   column into kortix.workspaces(workspace_id): NO ACTION, DEFERRABLE
 *   INITIALLY DEFERRED (the old key keeps the ON DELETE action until Release
 *   2b re-creates the twins). A new foreign key into projects without a twin
 *   fails here: Release 3 drops the old keys, so a missing twin would lose the
 *   reference silently (learning 2026-08-19T163833Z).
 * - the check runs at commit: a project created and referenced in one
 *   transaction commits; a workspaces row deleted under a live reference fails
 *   the commit; a project delete still cascades through the old key.
 * - 20261114163000000_workspaces_reconcile_missing_rows restores the row of an
 *   account that has none (invariants I9 and I12).
 *
 * Every row is synthetic and lives in a transaction that rolls back, or is
 * deleted in `finally`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import { up as reconcileMissingRows } from '../migrations/20261114163000000_workspaces_reconcile_missing_rows.concurrent.ts';
import { up as reconcileFromNilUuid } from '../migrations/20261114171401000_workspaces_reconcile_nil_uuid_account.concurrent.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ACCOUNT = '00000000-0000-4000-a000-00000000e101';
const PROJECT = '00000000-0000-4000-a000-00000000e201';
const LOST_ACCOUNT = '00000000-0000-4000-a000-00000000e102';
/** The first uuid: prod and dev each hold one account with this id and no workspaces row (2026-11-14). */
const NIL_ACCOUNT = '00000000-0000-0000-0000-000000000000';

interface ForeignKey {
  child: string;
  column: string;
  name: string;
  on_delete: string;
  deferrable: boolean;
  deferred: boolean;
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Single-column foreign keys into `parent(column)`, by child table and column. */
async function foreignKeysInto(client: pg.Client, parent: string, column: string): Promise<ForeignKey[]> {
  const { rows } = await client.query<ForeignKey>(
    `select c.conrelid::regclass::text as child, a.attname as column, c.conname as name,
            c.confdeltype::text as on_delete, c.condeferrable as deferrable, c.condeferred as deferred
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       join pg_attribute r on r.attrelid = c.confrelid and r.attnum = c.confkey[1]
      where c.contype = 'f' and c.confrelid = $1::regclass and r.attname = $2
        and cardinality(c.conkey) = 1
      order by 1, 2, 3`,
    [parent, column],
  );
  return rows;
}

suite('Workspaces R2a: twin foreign keys into kortix.workspaces', () => {
  test('every foreign key into projects(project_id) has a NO ACTION, deferred twin into workspaces(workspace_id)', async () => {
    await withClient(async (client) => {
      const old = await foreignKeysInto(client, 'kortix.projects', 'project_id');
      const twins = await foreignKeysInto(client, 'kortix.workspaces', 'workspace_id');
      expect(old.length).toBeGreaterThan(70);
      const twinOf = new Map(twins.map((fk) => [`${fk.child}.${fk.column}`, fk]));
      const missing = old.filter((fk) => !twinOf.has(`${fk.child}.${fk.column}`)).map((fk) => `${fk.child}.${fk.column}`);
      expect(missing).toEqual([]);
      for (const fk of old) {
        const twin = twinOf.get(`${fk.child}.${fk.column}`)!;
        // 'a' = NO ACTION. Release 2b gives each twin the old key's action.
        expect({ name: twin.name, on_delete: twin.on_delete, deferrable: twin.deferrable, deferred: twin.deferred }).toEqual({
          name: `${fk.child.replace(/^kortix\./, '')}_${fk.column}_workspaces_fk`,
          on_delete: 'a',
          deferrable: true,
          deferred: true,
        });
      }
      // No twin without an old key: the set is exactly the old set.
      expect(twins.length).toBe(old.length);
    });
  });

  test('a project created and referenced in one transaction commits: the twin checks at commit', async () => {
    await withClient(async (client) => {
      try {
        await client.query('begin');
        await client.query(`insert into kortix.accounts (account_id, name) values ($1, 'Synthetic twin')`, [ACCOUNT]);
        await client.query(
          `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1, $2, 'Synthetic twin', 'https://example.invalid/twin.git')`,
          [PROJECT, ACCOUNT],
        );
        await client.query(`insert into kortix.project_llm_routing_policies (project_id) values ($1)`, [PROJECT]);
        await client.query('commit');
        const { rows } = await client.query(`select count(*)::int as n from kortix.project_llm_routing_policies where project_id = $1`, [PROJECT]);
        expect(rows[0].n).toBe(1);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.query(`delete from kortix.accounts where account_id = $1`, [ACCOUNT]);
      }
    });
  });

  test('a workspaces row deleted under a live reference fails the commit; a project delete still cascades', async () => {
    await withClient(async (client) => {
      try {
        await client.query(`insert into kortix.accounts (account_id, name) values ($1, 'Synthetic twin')`, [ACCOUNT]);
        await client.query(
          `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1, $2, 'Synthetic twin', 'https://example.invalid/twin.git')`,
          [PROJECT, ACCOUNT],
        );
        await client.query(`insert into kortix.project_llm_routing_policies (project_id) values ($1)`, [PROJECT]);

        // A stray delete of the live row (the class 20261111135934314 removed from the reconcile).
        await client.query('begin');
        await client.query(`delete from kortix.workspaces where workspace_id = $1`, [PROJECT]);
        const refused = await client.query('commit').then(
          () => null,
          (error: { code?: string; constraint?: string }) => error,
        );
        expect(refused?.code).toBe('23503');
        expect(refused?.constraint).toBe('project_llm_routing_policies_project_id_workspaces_fk');
        const { rows: kept } = await client.query(`select count(*)::int as n from kortix.workspaces where workspace_id = $1`, [PROJECT]);
        expect(kept[0].n).toBe(1);

        // The old key cascades; the reconcile then deletes the row; the twin finds nothing at commit.
        await client.query(`delete from kortix.projects where project_id = $1`, [PROJECT]);
        const { rows: gone } = await client.query(
          `select (select count(*)::int from kortix.project_llm_routing_policies where project_id = $1) as children,
                  (select count(*)::int from kortix.workspaces where workspace_id = $1) as rows`,
          [PROJECT],
        );
        expect(gone[0]).toEqual({ children: 0, rows: 0 });
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.query(`delete from kortix.accounts where account_id = $1`, [ACCOUNT]);
      }
    });
  });

  test('an account whose id is the first uuid: the first pass skips it, the nil-uuid pass restores it', async () => {
    await withClient(async (client) => {
      try {
        await client.query('begin');
        await client.query('alter table kortix.accounts disable trigger accounts_workspaces_sync');
        await client.query(`insert into kortix.accounts (account_id, name) values ($1, 'Synthetic nil')`, [NIL_ACCOUNT]);
        await client.query('alter table kortix.accounts enable trigger accounts_workspaces_sync');
        await client.query('commit');
        const count = async () =>
          Number((await client.query(`select count(*)::int as n from kortix.workspaces where legacy_account_id = $1`, [NIL_ACCOUNT])).rows[0].n);
        const pgm = { noTransaction: () => undefined, db: { query: (text: string) => client.query(text) } };

        // 20261114163000000 starts its keyset AT the first uuid with `>`: no candidate (prod and dev, 2026-11-14).
        await reconcileMissingRows(pgm as never);
        expect(await count()).toBe(0);

        await reconcileFromNilUuid(pgm as never);
        expect(await count()).toBe(1);
        // Idempotent.
        await reconcileFromNilUuid(pgm as never);
        expect(await count()).toBe(1);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.query(`delete from kortix.accounts where account_id = $1`, [NIL_ACCOUNT]);
      }
    });
  });

  test('the missing-row repair restores the row of an account that has none', async () => {
    await withClient(async (client) => {
      try {
        // An account the reconcile trigger never saw.
        await client.query('begin');
        await client.query('alter table kortix.accounts disable trigger accounts_workspaces_sync');
        await client.query(`insert into kortix.accounts (account_id, name) values ($1, 'Synthetic lost')`, [LOST_ACCOUNT]);
        await client.query('alter table kortix.accounts enable trigger accounts_workspaces_sync');
        await client.query('commit');
        const count = async () =>
          Number(
            (await client.query(`select count(*)::int as n from kortix.workspaces where legacy_account_id = $1`, [LOST_ACCOUNT])).rows[0].n,
          );
        expect(await count()).toBe(0);

        const pgm = { noTransaction: () => undefined, db: { query: (text: string) => client.query(text) } };
        await reconcileMissingRows(pgm as never);
        expect(await count()).toBe(1);
        const { rows } = await client.query(
          `select workspace_id::text, lifecycle from kortix.workspaces where legacy_account_id = $1`,
          [LOST_ACCOUNT],
        );
        expect(rows[0]).toEqual({ workspace_id: LOST_ACCOUNT, lifecycle: 'dormant' });

        // Idempotent: a rerun changes nothing.
        await reconcileMissingRows(pgm as never);
        expect(await count()).toBe(1);

        // A project row the trigger never saw, in an account that has its row.
        await client.query('begin');
        await client.query('alter table kortix.projects disable trigger projects_workspaces_sync');
        await client.query(
          `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1, $2, 'Synthetic lost', 'https://example.invalid/lost.git')`,
          [PROJECT, LOST_ACCOUNT],
        );
        await client.query('alter table kortix.projects enable trigger projects_workspaces_sync');
        await client.query('commit');
        const projectRow = async () =>
          Number((await client.query(`select count(*)::int as n from kortix.workspaces where workspace_id = $1`, [PROJECT])).rows[0].n);
        expect(await projectRow()).toBe(0);
        await reconcileMissingRows(pgm as never);
        expect(await projectRow()).toBe(1);
      } finally {
        await client.query('rollback').catch(() => undefined);
        await client.query(`delete from kortix.accounts where account_id = $1`, [LOST_ACCOUNT]);
      }
    });
  });
});
