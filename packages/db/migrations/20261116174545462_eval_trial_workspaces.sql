-- Migration: eval_trial_workspaces
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

CREATE TABLE "kortix"."eval_trial_workspaces" (
	"trial_account_id" uuid PRIMARY KEY NOT NULL,
	"trial_project_id" uuid NOT NULL,
	"trial_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"payer_account_id" uuid NOT NULL,
	"job_project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"budget_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"funded_at" timestamp with time zone,
	"refund_usd" numeric(12, 4),
	"settled_at" timestamp with time zone,
	"cleanup_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."eval_trial_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_eval_trial_workspaces_trial" ON "kortix"."eval_trial_workspaces" USING btree ("trial_id");--> statement-breakpoint
CREATE INDEX "idx_eval_trial_workspaces_live" ON "kortix"."eval_trial_workspaces" USING btree ("cleanup_after") WHERE "kortix"."eval_trial_workspaces"."deleted_at" is null;