---
recorded: 2026-10-20T14:16:06Z
incident_date: 2026-10-20
---
# Count the table before acting on stats, and give every append-only partition a retention owner

**Rule:** Never act on `pg_stat_user_tables` emptiness — run `count(*)` first; its
live/dead counters can be zero on a populated table autovacuum has never reached.
Every append-only table ships with an age-based purge owner on day one, and a
destructive claim against it asserts the data's actual age column, not the table
name.

**Trigger surface:** a database over its size limit, a cleanup of event/audit
tables, or adding any table that only ever grows.

**Incident:** 2026-10-20, prod Supabase `postgres` database: 515 MB against a
500 MB plan limit. Cause: no retention job for the weekly `audit_events`
partitions. One event storm had written 148,306 rows into a single weekly
partition (198 MB, 2026-10-05..10-08); next week wrote 6,537. Autovacuum had
never run on it and the stats reported 0 live rows for all 148k. The partition
was truncated only after asserting `max(occurred_at) < 2026-10-13` — 198 MB
freed on the spot, database down to 317 MB, the current week and the legacy
audit table (128 MB, still part of the `audit_events_all` read contract) kept.
Three earlier read-only probes cost four failed attempts: percent-encoded pool
passwords must be percent-decoded, pooler TLS needs the CA, and a worktree
without node_modules runs no `bun test`.

**Enforcement:** none yet: an age-based purge worker for `kortix.audit_events`
(partition-aware, default retention) plus a dashboard alarm on
`pg_database_size` at 80% of plan.
