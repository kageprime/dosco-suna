-- Migration: eval_pause_and_soft_cancel
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
-- mixed-version-safe: both status checks only widen (adds 'paused'); code from before this migration never writes 'paused' or cancel_mode, and the new code writes them only after this migration runs (migrations land before the rollout).
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

ALTER TABLE "kortix"."eval_jobs" ADD COLUMN "cancel_mode" text;--> statement-breakpoint
ALTER TABLE "kortix"."eval_jobs" ADD CONSTRAINT "eval_jobs_cancel_mode_check" CHECK ("kortix"."eval_jobs"."cancel_mode" in ('soft', 'hard')) NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."eval_jobs" DROP CONSTRAINT "eval_jobs_status_check";--> statement-breakpoint
ALTER TABLE "kortix"."eval_jobs" ADD CONSTRAINT "eval_jobs_status_check" CHECK ("kortix"."eval_jobs"."status" in ('queued', 'running', 'paused', 'completed', 'cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."eval_trials" DROP CONSTRAINT "eval_trials_status_check";--> statement-breakpoint
ALTER TABLE "kortix"."eval_trials" ADD CONSTRAINT "eval_trials_status_check" CHECK ("kortix"."eval_trials"."status" in ('queued', 'paused', 'starting', 'agent_running', 'verifying', 'completed', 'errored', 'cancelled')) NOT VALID;
