---
recorded: 2026-11-28T11:45:08Z
incident_date: 2026-11-28
---
# Apply pending migrations before an image reads their columns; make the deploy run them

**Rule:** Before any deploy that ships code reading a new column or table, run `migrate.ts status` on the target database and apply every pending file. Give the Fly API app a `[deploy] release_command` so each image carries its own migration step. Never assume a manual migrate from an earlier session happened.

**Trigger surface:** An upstream sync into a managed deployment; a Fly or Heroku API deploy; any new file in `packages/db/migrations`.

**Incident:** 2026-11-28, after the upstream sync. Prod had 9 pending migrations while the deployed API selected `kortix.artifacts.gallery_folder_id`; `GET /v1/workspaces/<id>/artifacts` returned `500` with `42703 column "gallery_folder_id" does not exist`. `fly.api.toml` had no release command, so image builds and rollouts never applied schema changes. Running `migrate.ts up` inside the live machine cleared all 9; the query then ran with 0 rows.

**Enforcement:** foundation `OPS-03` (`contains` on `fly.api.toml` for the `migrate.ts up` release command), run by `bun test tests/unit/dosco-foundations.test.ts`. Confirm at deploy time with `migrate.ts status` → `Up to date - no pending migrations.`
