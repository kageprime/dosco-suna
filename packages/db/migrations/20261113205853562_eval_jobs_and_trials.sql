-- Migration: eval_jobs_and_trials
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

CREATE TABLE "kortix"."eval_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"suite" text,
	"job_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"commit_sha" text,
	"ref" text,
	"config" jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rerun_of" uuid,
	"drive_id" uuid,
	"folder" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_jobs_status_check" CHECK ("kortix"."eval_jobs"."status" in ('queued', 'running', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."eval_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."eval_trials" (
	"trial_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"trial_name" text NOT NULL,
	"task_name" text NOT NULL,
	"task_ref" jsonb NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"attempt" integer NOT NULL,
	"retry" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"session_id" text,
	"rewards" jsonb,
	"reward_valid" boolean DEFAULT false NOT NULL,
	"exception" jsonb,
	"run_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb,
	"environment_started_at" timestamp with time zone,
	"environment_finished_at" timestamp with time zone,
	"agent_started_at" timestamp with time zone,
	"agent_finished_at" timestamp with time zone,
	"verifier_started_at" timestamp with time zone,
	"verifier_finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_trials_status_check" CHECK ("kortix"."eval_trials"."status" in ('queued', 'starting', 'agent_running', 'verifying', 'completed', 'errored', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."eval_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."eval_jobs" ADD CONSTRAINT "eval_jobs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."eval_trials" ADD CONSTRAINT "eval_trials_job_id_eval_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "kortix"."eval_jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_eval_jobs_project_created" ON "kortix"."eval_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eval_jobs_project_name" ON "kortix"."eval_jobs" USING btree ("project_id","job_name");--> statement-breakpoint
CREATE INDEX "idx_eval_jobs_active" ON "kortix"."eval_jobs" USING btree ("status") WHERE "kortix"."eval_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "idx_eval_trials_job" ON "kortix"."eval_trials" USING btree ("job_id","task_name","agent","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eval_trials_job_name" ON "kortix"."eval_trials" USING btree ("job_id","trial_name");--> statement-breakpoint
CREATE INDEX "idx_eval_trials_session" ON "kortix"."eval_trials" USING btree ("session_id") WHERE "kortix"."eval_trials"."session_id" is not null;