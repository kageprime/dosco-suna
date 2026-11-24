---
recorded: 2026-11-24T00:56:59Z
incident_date: 2026-11-24
---
# Treat a burst of ttlMemo timeouts as DB pool starvation and restart the dyno first

**Rule:** When many unrelated endpoints fail with `ttlMemo(<key>) timed out after 15000ms`, treat it as DB pool starvation, not a per-route bug. Restart the web dyno to clear the poisoned pool, then investigate long-running transactions.

**Trigger surface:** Reading Heroku API logs after a burst of 500s on workspace, session and billing routes; `db_pool_wait_suspected: true` and `db;dur` of 7-12 s on successful neighbours confirm it.

**Incident:** 2026-11-24 00:53-00:55 UTC, production web.1. A single shared ttlMemo loader stalled on the Supavisor pool; in-flight de-duplication made every parallel page request fail together, and session/start returned 503 at the 25 s deadline. The v164 deploy at 01:24 UTC restarted the dyno and cleared it; no errors after that.

**Enforcement:** None yet: build a metric/alert that fires when `ttlMemo(... timed out` plus `db_pool_wait_suspected` exceed a threshold in a short window, so the restart happens without waiting for a human to read logs.
