-- Migration: calendar_item_people
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

CREATE TABLE "kortix"."calendar_item_people" (
	"item_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"agent" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_item_people_one_kind" CHECK (("kortix"."calendar_item_people"."user_id" IS NULL) <> ("kortix"."calendar_item_people"."agent" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "kortix"."calendar_item_people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- One owner becomes a list of people (persons and agents). Only the calendar routes read
-- these columns, behind the `calendar` flag (off by default; on in one internal dev test
-- workspace); staging and production have run neither calendar migration. Dropping assignee_user_id
-- drops idx_calendar_items_project_assignee with it. No backfill: dev test data only.
-- mixed-version-safe: only the flagged calendar routes read assignee_user_id/assignee_agent, and a replica still on the old code answers a calendar request with an error at worst while the deploy rolls (flag on in one internal test workspace only).
ALTER TABLE "kortix"."calendar_items" DROP CONSTRAINT "calendar_items_one_assignee";--> statement-breakpoint
ALTER TABLE "kortix"."calendar_items" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."calendar_item_people" ADD CONSTRAINT "calendar_item_people_item_id_calendar_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "kortix"."calendar_items"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_calendar_item_people_user" ON "kortix"."calendar_item_people" USING btree ("item_id","user_id") WHERE "kortix"."calendar_item_people"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_calendar_item_people_agent" ON "kortix"."calendar_item_people" USING btree ("item_id","agent") WHERE "kortix"."calendar_item_people"."agent" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_calendar_item_people_project_user" ON "kortix"."calendar_item_people" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_item_people_project_agent" ON "kortix"."calendar_item_people" USING btree ("project_id","agent");--> statement-breakpoint
-- squawk-ignore ban-drop-column
ALTER TABLE "kortix"."calendar_items" DROP COLUMN "assignee_user_id";--> statement-breakpoint
-- squawk-ignore ban-drop-column
ALTER TABLE "kortix"."calendar_items" DROP COLUMN "assignee_agent";--> statement-breakpoint
ALTER TABLE "kortix"."calendar_items" ADD CONSTRAINT "calendar_items_ends_after_starts" CHECK ("kortix"."calendar_items"."ends_at" IS NULL OR ("kortix"."calendar_items"."starts_at" IS NOT NULL AND "kortix"."calendar_items"."ends_at" > "kortix"."calendar_items"."starts_at")) NOT VALID;
-- Every existing row has ends_at NULL, so it satisfies the check; it binds every new row, and no VALIDATE scan runs.