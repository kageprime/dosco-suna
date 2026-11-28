---
recorded: 2026-11-23T18:01:42Z
incident_date: 2026-11-23
supersedes: 2026-09-24T201058Z-client-database-roles-get-no-privileged-grant-a-blanket-gran.md
---
# Keep the Supabase Data API off on every environment; Kortix reaches Postgres directly and never calls PostgREST

**Rule:** Keep the Supabase Data API (PostgREST, `/rest/v1`, `/graphql/v1`) off: hosted projects in Integrations → Data API, local Supabase with `-x postgrest` on every `supabase start`. Read and write Postgres only through the API. Never add a `supabase.from()` / `.rpc()` call or turn the Data API back on for a feature. The 2026-09-24 grant rule stands unchanged as the second layer: client roles get no privileged grant.

**Trigger surface:** Supabase project settings (Data API, exposed schemas, a role-level `pgrst.db_schemas`), a new `supabase start` call, a client that wants data straight from Supabase, a grant to `anon` or `authenticated`.

**Incident:** The anon key and any user JWT reached our database through PostgREST twice: wallet RPCs and `kortix` tables on 2026-09-24, legacy `public` tables on 2026-11-05. On 2026-11-23, prod showed no Data API caller of ours: 7 days of `/rest/v1` edge logs held only failed scanner probes, and the only PostgREST data calls since June hit functions dropped on 09-25. That day the Data API went off on dev, staging and prod (PR #13027). Dev also had a hand-set `pgrst.db_schemas` on `authenticator` that overrode the switch until it was reset. With PostgREST on, every fresh local `supabase start` also waited its 30 s health timeout.

**Enforcement:** flow `SEC-K` (tagged `deployed`) calls `/rest/v1` and `/graphql/v1` as the anon key and as a user, and fails when any schema answers: locally on every run, and against staging in the release suite. Prod has no automatic check; prove it with a GET on `/rest/v1/accounts` with `accept-profile: kortix`, which must name only `pg_pgrst_no_exposed_schemas`. The grant layer moved from SEC-K to `apps/api/src/__tests__/integration-kortix-rls.test.ts`, `tests/migration/credit-rpc-overloads.test.ts` and the post-condition of `20260924194804787_client_role_lockdown`.
