---
recorded: 2026-11-25T23:31:04Z
incident_date: 2026-11-24
---
# Bound admission to the shared DB pool before the request deadline

**Rule:** Put a bounded admission gate in front of a shared Postgres pool whose client has no acquire-queue timeout. Fail a burst caller in ~2 s with a retryable 503, never let it sit in an unbounded FIFO until the request deadline cuts every caller at once.

**Trigger surface:** Raising a pool ceiling, adding a hot polling client, or seeing several unrelated routes log `db;dur≈25000` with `db_pool_wait_suspected: true` in the same window. `statement_timeout` does not help: each queued statement is fast, the wait happens before it is sent.

**Incident:** 2026-11-24 23:39-23:41 UTC, Heroku `web.1`. One polling client drove `/v1/accounts`, `/v1/notifications`, `/v1/notifications/preferences` and one workspace read into repeated 25 s waits; all returned 503 at the request deadline. `DB_CONNECT_TIMEOUT_S=60` was longer than the deadline and gave no protection. Health returned 200 in 0-2 ms at 23:42 and no pool-wait errors followed. Prior incident on the same day (00:53-00:55 UTC) was cleared by a dyno restart with no fix committed.

**Enforcement:** `apps/api/src/middleware/db-admission.test.ts` pins the ceiling, the handoff and the bounded reject. `apps/api/src/config.ts` exposes `DB_ADMISSION_WAIT_MS`; `apps/api/src/middleware/db-admission.ts` logs `db_admission_wait_ms` and `db_admission_status: rejected` for an alert. No alert rule exists yet: build one that pages on repeated reject lines in a 5-minute window.
