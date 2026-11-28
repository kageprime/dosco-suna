---
recorded: 2026-11-28T15:26:34Z
incident_date: 2026-11-28
---
# Keep the API in the database region; measure round-trip time before tuning a pool

**Rule:** Deploy the API in the same region as its Postgres server. Before changing `DB_POOL_MAX`, measure a plain `select 1` round trip from the running machine. A cross-Atlantic API cannot be fixed by a bigger pool: measure latency first, then size concurrency from it.

**Trigger surface:** Any Fly or Heroku API deploy, any `db_pool_busy` report, any change to `DB_POOL_MAX`, `DB_ADMISSION_WAIT_MS`, or a cloud region.

**Incident:** 2026-11-28. The API ran in `iad` while Supabase is in `eu-west-1`. A `select 1` cost 91 ms from `iad` and 11-12 ms from `lhr`; connection setup cost 670 ms vs 118 ms. Every browser request pays one RTT for `supabase.auth.getUser` plus one per SQL statement. A workspace page with ~20 parallel calls saturated the 5-slot admission ceiling and returned `503 db_pool_busy`. This topology existed on Heroku too, which is why the symptom persisted for months. Cloning the machine to `lhr` and raising `DB_POOL_MAX` to 14 removed it. A clone does not inherit secrets added after the source machine was created: rerun `flyctl secrets set` after cloning.

**Enforcement:** foundations `OPS-04` (`primary_region = "lhr"`) and `OPS-05` (`DB_POOL_MAX = "14"`), run by `bun test tests/unit/dosco-foundations.test.ts`; the RTT probe procedure in the live-deploy runbook section 0.1.
