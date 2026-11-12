---
recorded: 2026-11-10T02:15:57Z
incident_date: 2026-11-10
---
# Never INCLUDE a jsonb or unbounded text column in a btree index; cost the widest row on prod before an index build

**Rule:** A btree index entry holds at most 2,704 bytes. Never put a `jsonb` or unbounded `text` column in `INCLUDE (...)` or in the key. Before a migration builds an index on a large table, measure the widest value of every indexed column on prod, read-only: `select max(octet_length(<col>::text)) from <table>`. The release suite runs on staging data, which is too small to show this.

**Trigger surface:** writing a covering index (`INCLUDE`) or any index on `gateway_request_logs`, `audit_events`, session logs or another table with a `metadata`/`payload` column; costing migrations before a promote.

**Incident:** 2026-11-10, v0.15.3 deploy-prod 42732045038. `20261107145000000_gateway_logs_project_time_covering_v2` (`INCLUDE (... metadata)`) failed on prod: `index row size 4944 exceeds btree version 4 maximum 2704`. Prod `metadata` reaches ~25 KB; dev and staging rows are small, so every release-suite lane was green. The migrate job halted after 35 migrations; the API stayed on v0.15.2 for ~30 min while npm packages and image tags were already v0.15.3. Recovery: the INVALID v2 (`indisready = false`) and an empty `idx_..._v3 ... WHERE false` placeholder made both `if not exists` builds skip; the chain's own drops removed them; the rerun migrated in 14 min.

**Enforcement:** #12214 skips the two superseded builds through a checksum-guarded runtime override (`packages/db/scripts/migration-runtime-overrides.ts`), so self-host upgrades pass. None yet for the rule itself: `packages/db/scripts/lint-migrations.ts` should reject an index whose key or `INCLUDE` list names a `jsonb` column.
