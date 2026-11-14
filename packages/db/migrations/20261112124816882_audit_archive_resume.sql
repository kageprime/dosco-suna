-- Migration: audit_archive_resume
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

-- WHAT: one new table (kortix.audit_archive_parts) and one nullable column without a default on
--   kortix.audit_archive_chunks (a catalog-only change; the table holds one row per week, ~20 rows).
--   The foreign key and the index are on the new, empty table.
-- WHY: the audit archive export of one week runs longer than the prod worker lives (a week's
--   legacy tally alone is ~2 h 50 min at the rate cap), and every restart began the week again.
--   The export now records its tally and each uploaded object, and a restart continues from there.
-- mixed-version-safe: added table and added nullable column; the old code reads neither, and the
--   old code's INSERT/UPDATE on audit_archive_chunks names its columns.
-- ROLL BACK: no down migration (repo policy). The old code ignores both; the table stays.
CREATE TABLE "kortix"."audit_archive_parts" (
	"object_key" text PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"account_id" uuid,
	"part" integer NOT NULL,
	"row_count" integer NOT NULL,
	"byte_count" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"checksum_sum" numeric NOT NULL,
	"first_occurred_at" text NOT NULL,
	"last_occurred_at" text NOT NULL,
	"last_event_id" uuid NOT NULL,
	"account_done" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."audit_archive_chunks" ADD COLUMN "legacy_tally" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."audit_archive_parts" ADD CONSTRAINT "audit_archive_parts_week_fk" FOREIGN KEY ("week_start") REFERENCES "kortix"."audit_archive_chunks"("week_start") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_archive_parts_week_idx" ON "kortix"."audit_archive_parts" USING btree ("week_start");--> statement-breakpoint
-- Like every kortix table: no Data API access.
ALTER TABLE "kortix"."audit_archive_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "kortix"."audit_archive_parts" FROM anon, authenticated;
