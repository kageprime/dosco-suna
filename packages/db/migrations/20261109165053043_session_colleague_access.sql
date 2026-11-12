-- Migration: session_colleague_access
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Generated from the chain's true leaf (20261107164532). The stale snapshot
-- 20261108090000 (#12076) forked the chain from 20261104004540 and is gone; the
-- gateway_request_logs changes it held are applied by #12076's own
-- 20261108090000* migrations, so they are not repeated here.
--
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

CREATE TABLE "kortix"."session_colleague_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"surface_session_id" text,
	"title" text NOT NULL,
	"connectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_hash" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decided_by" uuid,
	"consumed_at" timestamp with time zone,
	"consumed_by_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_colleague_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."session_colleague_access" ADD CONSTRAINT "session_colleague_access_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_colleague_access_open_uniq" ON "kortix"."session_colleague_access" USING btree ("session_id","access_hash") WHERE decided_at IS NULL;--> statement-breakpoint
CREATE INDEX "session_colleague_access_project_open_idx" ON "kortix"."session_colleague_access" USING btree ("project_id") WHERE decided_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_colleague_access_colleague_uniq" ON "kortix"."session_colleague_access" USING btree ("consumed_by_session_id") WHERE consumed_by_session_id IS NOT NULL;
