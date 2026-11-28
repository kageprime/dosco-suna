---
recorded: 2026-11-23T22:36:02Z
incident_date: 2026-11-23
---
# Validate foreign keys after the column-add transaction commits

**Rule:** Validate a foreign key on an existing table in a separate migration after the column-add transaction and concurrent index build.

**Trigger surface:** Adding an artifact membership column and foreign key to an existing table.

**Incident:** 2026-11-24, pre-merge review caught validation in the same transaction as ADD COLUMN. PostgreSQL retains ACCESS EXCLUSIVE through the scan, blocking readers. No hosted deployment occurred. The local-applied migration remains immutable; a checksum-guarded runtime correction defers validation.

**Enforcement:** packages/db/scripts/migration-runtime-overrides.test.ts checks deferred validation and rejects checksum drift. A real PostgreSQL probe confirms concurrent reads during validation.
