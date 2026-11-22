-- Migration: session_groups_sharing_and_tabs
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

-- Spaces (session groups, flag `session_groups`): a group is private to its
-- creator and its members by default, and holds the tabs a channel has.
-- Existing groups become `private` (their creator's): a group now shares the
-- sessions in it, so making them visible to the whole project would show
-- members' private sessions to everyone. RLS is on with no policy: only the
-- API (owner role) reads the members table.

CREATE TABLE "kortix"."project_session_group_members" (
	"group_id" uuid NOT NULL REFERENCES "kortix"."project_session_groups"("group_id") ON DELETE cascade,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_session_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);--> statement-breakpoint
CREATE INDEX "idx_project_session_group_members_user" ON "kortix"."project_session_group_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "kortix"."project_session_group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ADD COLUMN "tabs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ADD CONSTRAINT "project_session_groups_visibility_check" CHECK ("visibility" in ('private', 'project')) NOT VALID;
