---
recorded: 2026-11-10T15:41:51Z
incident_date: 2026-11-05
---
# Revoke API-role access to a retired schema the day its last reader moves off it; never leave old RLS and RPCs reachable through PostgREST

**Rule:** When a schema loses its last product reader, in the same release revoke `anon` and `authenticated` on its tables, sequences and functions. Also remove it from the Supabase Data API exposed schemas (`db_schema`). The old RLS policies and RPCs stay callable with the publishable key until you do, even when no code of ours uses them.

**Trigger surface:** retiring or freezing a schema (`public`, `basejump`, any `kortix_*`), moving a table to `kortix`, or reviewing Supabase Data API settings.

**Incident:** On 2026-11-05 a new free sign-up called the old PostgREST API with curl. It created a team account through a legacy RPC and paged through about 4,900 pages of Suna-era `public.messages`, plus projects, agent_runs and threads. The old RLS showed every row of a thread or project marked `is_public`: 5,940 projects and 5,865 threads on prod. A second round of table probing followed on 11-09. The legacy schemas had had no product reader since the Kortix cutover, but `db_schema` still listed `public, graphql_public, basejump`. Contained on 2026-11-10: anon/authenticated were revoked on both schemas, and `db_schema` became `public, graphql_public`. The freeze migration `20261110135954872` carries the same revoke to every environment (PR #12243).

**Enforcement:** `tests/migration/resources-rls-require-account.test.ts` asserts `authenticated` loses SELECT on a legacy table after the freeze migration. None yet for `db_schema`: build a check that reads the Management API `/v1/projects/<ref>/postgrest` per environment and fails when it lists a schema without a product reader.
