---
recorded: 2026-11-12T12:52:26Z
incident_date: 2026-11-05
supersedes: 2026-11-10T154151Z-revoke-api-role-access-to-a-retired-schema-the-day-its-last.md
---
# Drop a retired schema once its last reader is gone and a restore-tested backup exists; a revoke alone leaves its RLS, RPCs and disk behind

**Rule:** The day a schema loses its last product reader, revoke `anon` and `authenticated` on it and remove it from the Data API `db_schema` (unchanged from the superseded entry). Then take one full backup, prove it with a restore test, and drop the schema in a migration whose guard refuses while any object outside the retired schemas depends on them. Before the drop, check what the dependency catalog cannot see: `pg_cron` jobs that call its functions by name, and storage policies per environment.

**Trigger surface:** retiring, freezing or dropping a schema (`public`, `basejump`, any `kortix_*`); moving a table to `kortix`; a migration with `DROP SCHEMA` or a loop of `DROP TABLE ... CASCADE`.

**Incident:** 2026-11-05 a new sign-up read Suna-era `public.messages` through the legacy PostgREST surface (see the superseded entry). The revoke contained it on 2026-11-10. The schemas still held 224.7 GB of prod disk and the legacy RPCs. `20261112124223964_drop_legacy_suna_schemas` (PR #12569) drops them after the 2026-11-10 backup and restore test. The guard check against each environment found blockers that prod did not have: a staging-only schema with a foreign key into `public`, a dev-only storage policy, and three cron jobs on dev and staging.

**Enforcement:** the migration's guard raises when a `kortix` object depends on a dropped schema (proved on a database built from the prod backup's DDL: it names the blocking view and rolls back). `tests/migration/resources-rls-require-account.test.ts`, the enforcer of the superseded entry, is deleted with the tables it tested. None yet for `db_schema`: build a check that reads the Management API `/v1/projects/<ref>/postgrest` per environment and fails when it lists a schema without a product reader.
