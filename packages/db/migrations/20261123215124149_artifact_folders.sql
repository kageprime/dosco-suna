-- Migration: artifact_folders
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

CREATE TABLE "kortix"."artifact_folders" (
	"folder_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"icon_glyph" jsonb,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_folders_name_check" CHECK (char_length(btrim("kortix"."artifact_folders"."name")) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."artifacts" ADD COLUMN "gallery_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_folders" ADD CONSTRAINT "artifact_folders_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_folders_project" ON "kortix"."artifact_folders" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "kortix"."artifacts" ADD CONSTRAINT "artifacts_gallery_folder_id_artifact_folders_folder_id_fk" FOREIGN KEY ("gallery_folder_id") REFERENCES "kortix"."artifact_folders"("folder_id") ON DELETE set null ON UPDATE no action NOT VALID;
-- Safe: gallery_folder_id is new and all pre-existing rows contain NULL.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE kortix.artifacts VALIDATE CONSTRAINT artifacts_gallery_folder_id_artifact_folders_folder_id_fk;
ALTER TABLE kortix.artifact_folders ADD CONSTRAINT artifact_folders_workspace_fk
  FOREIGN KEY (project_id) REFERENCES kortix.workspaces(workspace_id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID;
-- Safe: artifact_folders is created empty in this transaction.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE kortix.artifact_folders VALIDATE CONSTRAINT artifact_folders_workspace_fk;
