-- Migration: project_space_activity
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A channel's agent changes, for its timeline lines ("Kortix was added by
-- <person>"). Additive only: the table is new and empty, so its check, index
-- and FK scan nothing, and code from before this migration never reads it.
-- The FK to project_spaces takes a brief SHARE ROW EXCLUSIVE lock on it
-- (bounded by lock_timeout). RLS is on with no policy: only the API (owner
-- role) reads it, as for the other channel tables (project_channels.sql).

CREATE TABLE "kortix"."project_space_activity" (
	"activity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agent_name" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_space_activity_kind_check" CHECK ("kortix"."project_space_activity"."kind" in ('agent_added', 'agent_removed'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_space_activity" ADD CONSTRAINT "project_space_activity_space_id_project_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_space_activity_space" ON "kortix"."project_space_activity" USING btree ("space_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "kortix"."project_space_activity" ENABLE ROW LEVEL SECURITY;
