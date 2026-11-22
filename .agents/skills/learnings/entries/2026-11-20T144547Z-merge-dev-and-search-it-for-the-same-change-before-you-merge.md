---
recorded: 2026-11-20T14:45:47Z
incident_date: 2026-11-20
---
# Merge dev and search it for the same change before you merge a migration

**Rule:** Before you merge a migration, merge `dev` into the branch and search
`packages/db/migrations` for the object you add. If dev already adds it, drop
your migration.

**Trigger surface:** Two branches fix the same schema gap in parallel, for
example two factory sessions for one red nightly lane.

**Incident:** 2026-11-20: #12938 and #12944 each added
`project_trigger_admissions_project_id_workspaces_fk`, under the same slug,
30 min apart. The second file failed with 42710 ("already exists") on dev and
on every fresh database. Every dev deploy skipped the API for ~4 h, and the
next staging promote would have failed the same way. #12947 added a
checksum-pinned runtime correction; the committed file stays unchanged.

**Enforcement:** `lintMigrationSet` (`pnpm --filter @kortix/db lint`) rejects
a second migration with an existing slug.
`trigger-admissions-twin-duplicate.integration.test.ts` proves the runtime
copy on real PostgreSQL. A same-object check under a different slug: none yet.
