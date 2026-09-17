-- Migration: 20260909134742448_paystack_columns
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW CHECKLIST: additive NULLABLE columns only — no backfill, no locks
-- beyond a sub-second ACCESS EXCLUSIVE on each table's DDL. Old code ignores
-- unknown columns; new code tolerates absent columns until this migration
-- runs (reads return NULL). Safe in either version order.
-- mixed-version-safe: ADD COLUMN nullable reads as NULL on old code.
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "paystack_subscription_code" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "paystack_email_token" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."credit_purchases" ADD COLUMN "paystack_reference" varchar(255);--> statement-breakpoint
ALTER TABLE "kortix"."credit_purchases" ADD COLUMN "paystack_access_code" varchar(255);
