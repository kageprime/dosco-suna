---
recorded: 2026-11-10T13:57:58Z
incident_date: 2026-11-10
---
# A mass-UPDATE migration over a table with index-only readers vacuums the table before the deploy moves on

**Rule:** A batched data pass that UPDATEs rows of a table with index-only readers
(`gateway_request_logs` and every table behind a `*covering*` index) ends with
`VACUUM (ANALYZE) <table>;` inside the same migration, after the last pass. Every
UPDATE moves the row, un-marks the page's all-visible bit, and adds index entries —
so every index-only scan on the table heap-fetches every wide row until a vacuum
runs. Do not rely on autovacuum: at 4.1 M rows the cleanup runs for hours behind
live traffic, and every cost-explorer page load in that window pays the full heap.
The same applies to any future migration that mass-updates (or mass-DELETEs on) a
table whose readers are index-only by design.

**Trigger surface:** Writing or reviewing a `// batched-dml:` migration over
`kortix.gateway_request_logs`, `kortix.sandbox_compute_sessions`,
`kortix.storage_charges`, `kortix.audit_events` — any table named in a covering-index
INCLUDE comment in `packages/db/src/schema/kortix.ts` or read by
`cost-rollups.ts` / `session-costs.ts` / `gateway-series.ts`.

**Incident:** 2026-11-10, v0.15.3 (deployed to prod 01:44 UTC). KRTX-4023's
`gateway_logs_llm_value_backfill` (20261108090000200) UPDATEd ~70 % of the 4.1 M-row
`gateway_request_logs`. From 12:29 UTC every account-wide `GET /v1/usage/cost-summary`
and `cost-by-project` request for a large account ran `db;dur≈25 s` (n=8 statements)
and hit the 25 s request deadline: 18 of 23 requests 503'd in an hour (KRTX-4638),
while small accounts stayed at 13-335 ms — their few heap fetches are cheap. The
coverage was 20 days of clean (max 3.6 s) history; the regression shipped with the
backfill, not with any route change. Remediation that restores prod: one manual
`VACUUM (ANALYZE) kortix.gateway_request_logs;` (online, no exclusive lock), or wait
for autovacuum to finish the table.

**Enforcement:** `apps/api/src/shared/integration-cost-rollups-covering-index.test.ts`
— DB suite, two tests: the three account-led LLM scans of the cost explorer must
EXPLAIN as `Index Only Scan using idx_gateway_logs_account_time_covering` with
`Heap Fetches: 0`, and a mass UPDATE must degrade the scan to heap fetches until
`VACUUM (ANALYZE)` restores 0 (the KRTX-4638 mechanism, red-green). The plan-shape
half extends the KRTX-4022 enforcement (`gateway-series.integration.test.ts`) to the
cost aggregates; note its GUC trio (`enable_indexscan = off`) also demotes Index Only
Scans on PG 17.6, so the new suite demotes only `enable_seqscan`/`enable_bitmapscan`
and prices the heap with scattered sibling-account rows instead.
