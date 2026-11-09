/**
 * Integration test (real PostgreSQL, fresh migrated database): no client role
 * reaches a `kortix` table. PostgREST exposes the schema, so isolation must not
 * rest on grants alone (pentest M-3): every table has RLS on, and anon,
 * authenticated and authenticator hold no table privilege.
 *
 * A new table fails this test until its migration enables RLS:
 *   ALTER TABLE kortix.<table> ENABLE ROW LEVEL SECURITY;
 */
import { expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import { db } from '../shared/db';

test('every kortix table has row level security on', async () => {
  const rows = (await db.execute(sql`
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'kortix' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND NOT c.relrowsecurity
     ORDER BY 1`)) as unknown as Array<{ relname: string }>;
  expect(rows.map((r) => r.relname)).toEqual([]);
});

test('anon, authenticated and authenticator hold no privilege on any kortix table', async () => {
  const rows = (await db.execute(sql`
    SELECT grantee || ' ' || privilege_type || ' ' || table_name AS grant
      FROM information_schema.role_table_grants
     WHERE table_schema = 'kortix' AND grantee IN ('anon', 'authenticated', 'authenticator', 'PUBLIC')
     ORDER BY 1`)) as unknown as Array<{ grant: string }>;
  expect(rows.map((r) => r.grant)).toEqual([]);
});

// GHSA-6vgj-r49c-fxmq: a SECURITY DEFINER function trusts its arguments
// (`p_account_id`, `p_amount`), so no client role may reach one. A schema-level
// REVOKE does not remove the global PUBLIC EXECUTE default: a function created
// by a later migration is client-executable unless that migration revokes it.
// Reachable = USAGE on the schema AND EXECUTE on the function.
test('anon and authenticated reach no SECURITY DEFINER function and no wallet function', async () => {
  const rows = (await db.execute(sql`
    SELECT r.rolname || ' ' || p.oid::regprocedure::text AS fn
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN pg_roles r
     WHERE r.rolname IN ('anon', 'authenticated')
       AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND (p.prosecdef OR n.nspname = 'kortix_wallet' OR p.proname LIKE 'atomic\_%')
       AND p.proname NOT IN ('has_role_on_account', 'get_accounts_with_role')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime',
                             'graphql', 'graphql_public', 'extensions', 'vault', 'pgsodium',
                             'supabase_functions', 'net', 'cron', 'pgbouncer')
       AND has_schema_privilege(r.rolname, n.oid, 'USAGE')
       AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     ORDER BY 1`)) as unknown as Array<{ fn: string }>;
  expect(rows.map((r) => r.fn)).toEqual([]);
});
