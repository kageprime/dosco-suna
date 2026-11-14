# Source: database observer (anomalies and optimisations)

Trigger `source-db-observer` (cron, hourly at :40, at most 24 runs a day).
Disabled by default. Settings: `sources.db-observer.backend`, `postgres` (any
host: RDS, Cloud SQL, Neon, self-hosted) or `supabase`, and `baseline_days`
(default 7). Read-only credentials only. The observer reads statistics
views, never a table row.

| | |
|---|---|
| Signal | Postgres statistics now against the previous snapshot and the baseline |
| Finding | an **anomaly** (error spike, lock waits, replication lag, table bloat, transaction id wraparound, connection saturation) or an **optimisation** (a slow query, a missing index, an unused index, an N+1 pattern) |
| Bar | the thresholds of each check below **and** a code anchor: a query you can `git grep` (its table and its distinctive clause), the migration or schema file that defines the table or index, or the loop that issues the query. An anomaly without a code anchor is not a ticket: it goes into the `db:ledger` digest and the run line (`alerts=`); the factory is not a pager |
| Key | `db:<backend>:<kind>:<sha1-12 of the normalized statement>` for `slowq` and `n-plus-1`; `db:<backend>:<kind>:<schema.table[.index]>` for `seqscan`, `unused-index`, `bloat`, `locks`; `db:<backend>:<kind>:<database>` for `replication`, `wraparound`, `connections`; `db:<backend>:log:<sha1-12 of the normalized message>`; `db:<backend>:advisor:<lint>:<schema.entity>` |
| Signal value | `signal: total_ms_per_h=<n> calls_per_h=<n> mean_ms=<n>` (queries) · `signal: seq_tup_read_per_h=<n> rows=<n>` · `signal: index_mb=<n> idx_scan=0 days=<n>` · `signal: dead_ratio=<x> dead_tup=<n>` · `signal: waiting=<n> max_wait_s=<n>` · `signal: lag_s=<n>` · `signal: lines_1h=<n> baseline_per_h=<x>` |
| Priority | 1 wraparound age ≥ 1.5 billion, a slot retaining ≥ 10 GB, connections ≥ 95 %; 2 a lock chain on a write path, an error spike, a query that takes ≥ 25 % of total time; 3 slow queries, missing indexes, N+1, bloat; 4 unused or duplicate indexes |
| Label | `source:db` |
| Kind | `bug` (anomalies with a code cause), `task` (optimisations) |
| Credentials | `postgres`: `FACTORY_DB_READONLY_URL`. `supabase`: `SUPABASE_ACCESS_TOKEN` (advisors and database read only) and `SUPABASE_PROJECT_REF`. Never a write role, never the application's own URL |
| Cap | contract hard rule 5 (5 new tickets a day) |

## The read-only credential (the person creates it once)

Postgres. The person runs this as an admin and stores the URL with
`kortix secrets request FACTORY_DB_READONLY_URL --scope runtime`:

```sql
create role kortix_factory_ro login password '<a new random password>' connection limit 2;
grant pg_monitor to kortix_factory_ro;     -- statistics views of every role; no table data
alter role kortix_factory_ro set default_transaction_read_only = on;
alter role kortix_factory_ro set statement_timeout = '5s';
alter role kortix_factory_ro set idle_in_transaction_session_timeout = '10s';
create extension if not exists pg_stat_statements;  -- needs shared_preload_libraries; managed hosts: enable it in the console
```

Point the URL at a read replica when one exists, and add `?sslmode=require`.
Supabase: a personal access token of an account with read access to the
project, and the project ref. On Supabase, `pg_stat_statements` lives in the
schema `extensions`: qualify it (`extensions.pg_stat_statements`).

## How to read

| Backend | Command |
|---|---|
| postgres | `psql "$FACTORY_DB_READONLY_URL" -X -A -t -v ON_ERROR_STOP=1 -c "<sql>"`; JSON with `select json_agg(t) from (<sql>) t` |
| supabase, SQL | `curl -sf -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query/read-only" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' -d '{"query":"<sql>"}'` |
| supabase, advisors | `GET https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/advisors/performance` and `…/advisors/security` |
| supabase, Postgres logs | `GET https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/analytics/endpoints/logs?sql=<urlencoded>&iso_timestamp_start=<ISO>&iso_timestamp_end=<ISO>` with `select timestamp, event_message from logs where source = 'postgres_logs' and …`; a `404`: the older route `…/analytics/endpoints/logs.all` with `from postgres_logs`. At most 8 requests a minute; 1,000 rows a response |

Every query below runs in under a second on a healthy database. A `5s`
timeout is a finding of its own: name it in `errors=timeout:<check>`.

## Anomalies

| Check | SQL (read-only) | Bar |
|---|---|---|
| Error spike | `select xact_commit, xact_rollback, deadlocks, conflicts, temp_files, temp_bytes from pg_stat_database where datname = current_database()` (delta against the snapshot); Postgres logs `ERROR`/`FATAL` grouped by normalized message | rollbacks ≥ 3× the baseline rate; any new deadlock; a new log pattern with ≥ 3 lines, or ≥ 20 lines at ≥ 5× the baseline |
| Lock waits | `select pid, pg_blocking_pids(pid) as blocked_by, wait_event_type, extract(epoch from now() - query_start)::int as wait_s, left(query, 300) as query from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0` | ≥ 3 waiting sessions, or one wait ≥ 30 s, in two passes in a row |
| Replication lag | primary: `select application_name, state, extract(epoch from replay_lag)::int as lag_s from pg_stat_replication`; replica: `select extract(epoch from now() - pg_last_xact_replay_timestamp())::int`; slots: `select slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as retained_bytes from pg_replication_slots` | lag ≥ 60 s; an inactive slot retaining ≥ 1 GB |
| Table bloat | `select schemaname, relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze from pg_stat_user_tables where n_dead_tup > 100000 and n_dead_tup > 0.2 * greatest(n_live_tup, 1)` | dead ratio ≥ 0.2 and no autovacuum in 24 h |
| Wraparound | `select datname, age(datfrozenxid) from pg_database` | age ≥ 1 billion |
| Connections | `select count(*) as used, current_setting('max_connections')::int as max, count(*) filter (where state = 'idle in transaction' and now() - state_change > interval '5 minutes') as idle_tx from pg_stat_activity` | used ≥ 80 % of max; idle in transaction ≥ 5 |

## Optimisations

| Check | SQL (read-only) | Bar |
|---|---|---|
| Slow queries | `select queryid, calls, total_exec_time, mean_exec_time, rows, left(query, 500) as query from pg_stat_statements order by total_exec_time desc limit 200` (Supabase: `extensions.pg_stat_statements`); delta per hour against the snapshot | mean ≥ 500 ms with ≥ 100 calls an hour; or ≥ 10 % of all execution time and ≥ 50 % growth against the baseline |
| Missing index | `select schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup from pg_stat_user_tables where n_live_tup > 100000 and seq_scan > 0 order by seq_tup_read desc limit 20` (delta per hour); Supabase advisor `unindexed_foreign_keys` | ≥ 1,000 sequential scans an hour on a table of ≥ 100,000 rows, reading ≥ 10,000 rows a scan, and a statement in `pg_stat_statements` that filters that table on a column without an index |
| Unused index | `select s.schemaname, s.relname, s.indexrelname, s.idx_scan, pg_relation_size(s.indexrelid) as bytes from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid where s.idx_scan = 0 and not i.indisunique and not i.indisprimary order by bytes desc limit 20`; the stats age: `select stats_reset from pg_stat_database where datname = current_database()`; Supabase advisors `unused_index`, `duplicate_index` | ≥ 10 MB, zero scans, statistics older than 14 days, and zero scans on every replica the person named |
| N+1 | `pg_stat_statements` rows with `calls` ≥ 10,000 an hour, `rows / calls` ≤ 1, `mean_exec_time` < 2 ms and a lookup by key (`where <column> = $1`); when a logs backend carries a request id: the same fingerprint ≥ 10 times in one request | the code anchor issues the query inside a loop (`for`, `.map(`, `forEach`, `Promise.all(`) or a per-item resolver |

## Normalize first

Replace in every statement and message: literals → `$<n>`, numbers → `<n>`,
UUIDs and hex ids → `<id>`, emails → `<email>`, IPs → `<ip>`, quoted strings
→ `<s>`. Never keep a raw statement with values, never a role or user name of
a person.

## Run

1. Read factory.json. Read the previous snapshot from the `db:ledger`
   ticket body (a fenced `json` block: `pg_stat_statements` top 200 as
   `queryid → calls, total_ms`, the `pg_stat_database` counters, the
   `seq_scan` counters, the time). None: this run only records the snapshot.
2. Run every check into files under `/tmp/factory/db/`. A failing check:
   name it in `errors=`, continue with the others.
3. Compute deltas and rates in code (`jq` or `bun`); a counter that went down
   was reset: treat this run as a fresh baseline for it.
4. Anchor each row above its bar: `git grep -n` the table and the distinctive
   clause in application code; the migration or schema file for an index or a
   table (`git grep -n "create index.*<name>"`, the ORM schema); the loop for
   an N+1. No anchor: digest line.
5. Cluster rows with one cause (a slow query, the sequential scans on its
   table and the missing index) into one finding; the strongest row decides
   the key.
6. Upsert (contract §5): `## Evidence` holds the normalized statement, the
   numbers and their window, the anchor `file:line`. `## Proposed change`:
   an index migration that follows the repository's migration rules, a query
   rewrite, a batched query (`where id = any($1)` or a join) for an N+1, a
   vacuum or autovacuum setting in the migration or infrastructure file that
   owns it. `## Acceptance`: `EXPLAIN (ANALYZE, BUFFERS)` on the dev
   environment with synthetic data, before and after; for an N+1, a test that
   counts the queries of one request. Never run `EXPLAIN ANALYZE` against
   production.
7. Rewrite the `db:ledger` body with the new snapshot and post one
   `[factory-source] update · digest` comment with the rows below the bar and
   every anomaly without an anchor, only when there are any.
8. End with `source-db-observer:`, the contract run line, `checks=<n>
   anomalies=<n> optimisations=<n> anchored=<n> alerts=<n>`.

## Never

- Never write to the database: no DDL, no `VACUUM`, no `ANALYZE`, no
  `pg_cancel_backend`, no `pg_terminate_backend`, no setting change.
- Never select from an application table. Never copy a row, a parameter
  value, a role name of a person or a log line with data into a ticket.
- Never accept a credential that can write: `select rolsuper, rolcreaterole,
  rolcreatedb from pg_roles where rolname = current_user` must be all false
  and `show default_transaction_read_only` must be `on`. Else stop with
  `errors=write-credential`.
