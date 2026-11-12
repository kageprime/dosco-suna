/**
 * `kortix.access_requests` carries exactly one secondary index: the unique
 * email constraint (KRTX-4699 — the waitlist endpoint's ON CONFLICT DO NOTHING
 * needs it; a constraint probe, never an unused read index). The Supabase
 * performance advisor flagged the read indexes the baseline built
 * (`idx_access_requests_email`, non-unique, and `idx_access_requests_status`)
 * as `unused_index`: no code path reads the table (the one reference is the
 * waitlist endpoint's INSERT, apps/api/src/access-control/index.ts). The
 * status index stays dropped; the email name returns as a UNIQUE constraint.
 * Reads the live catalog, never source text; mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The read index the unused-index drop removed and nothing re-adds. */
const DROPPED_INDEXES = ['idx_access_requests_status'];

suite('kortix.access_requests carries the unique email constraint and no read index', () => {
  // One fresh client per test: a pg Client cannot reconnect after end().
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  test('the table still exists with its primary key', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ index_name: string }>(`
        select i.relname as index_name
          from pg_class t
          join pg_index x on x.indrelid = t.oid
          join pg_class i on i.oid = x.indexrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix'
           and t.relname = 'access_requests'
           and x.indisprimary
      `);
      expect(rows.map((r) => r.index_name)).toEqual(['access_requests_pkey']);
    });
  });

  test('the dropped read indexes are gone from the catalog', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_index x on x.indexrelid = c.oid
         where n.nspname = 'kortix'
           and c.relname = any($1)
      `,
        [DROPPED_INDEXES],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([]);
    });
  });

  test('the email index exists, is unique, valid, and the only secondary index', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ relname: string; indisunique: boolean; indisvalid: boolean }>(`
        select c.relname, x.indisunique, x.indisvalid
          from pg_class t
          join pg_index x on x.indrelid = t.oid
          join pg_class c on c.oid = x.indexrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix'
           and t.relname = 'access_requests'
           and not x.indisprimary
      `);
      expect(rows).toEqual([{ relname: 'idx_access_requests_email', indisunique: true, indisvalid: true }]);
    });
  });
});
