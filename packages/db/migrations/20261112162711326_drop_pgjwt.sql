-- Migration: drop_pgjwt
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: drop the pgjwt extension: its six functions in schema `extensions` (sign, verify,
--   url_encode, url_decode, algorithm_sign, try_cast_double). No table, column or row changes.
-- WHY: Supabase enabled pgjwt on every project before Postgres 17, and Postgres 17 does not
--   support it. On 2026-11-12 the Supabase upgrade check
--   (GET /v1/projects/<ref>/upgrade/eligibility) named pgjwt as the only blocker on dev, staging
--   and prod. The Postgres 17 upgrade is the only way to shrink a project's provisioned disk.
-- UNUSED (checked 2026-11-12 on dev, staging and prod): no object depends on its functions
--   (pg_depend), no function body outside the extension names them (pg_proc.prosrc), no statement
--   in pg_stat_statements calls them (prod stats since 2026-06-24), and no file in this repository
--   names them. Supabase Auth signs its own JWTs. The role `postgres` owns the extension in all
--   three projects. The local stack runs Postgres 17, which has no pgjwt: IF EXISTS makes this a
--   no-op there.
-- SAFETY: no CASCADE. If any object depended on a pgjwt function, the DROP would fail and the
--   migration would roll back instead of removing that object.
-- LOCKS: only the extension's own functions; no table is locked.
-- mixed-version-safe: neither the old nor the new code calls a pgjwt function.
-- ROLL BACK: no down migration (repo policy). On Postgres 15,
--   `CREATE EXTENSION pgjwt WITH SCHEMA extensions;` re-creates it.
DROP EXTENSION IF EXISTS pgjwt;
