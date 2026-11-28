-- Migration: artifact_folder_parent
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- Nested gallery folders: a folder may sit inside another folder of the same
-- project. The API checks the project and rejects cycles; the FK keeps a parent
-- that disappears outside the API from leaving a dangling id (SET NULL: root).
ALTER TABLE "kortix"."artifact_folders" ADD COLUMN "parent_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_folders" ADD CONSTRAINT "artifact_folders_parent_folder_id_artifact_folders_folder_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "kortix"."artifact_folders"("folder_id") ON DELETE set null ON UPDATE no action NOT VALID;
-- The index is the next (concurrent) migration; validation runs after both commit.
