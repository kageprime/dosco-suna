-- Migration: secret_consumer_browser
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A website login (`{ username, password }`) is a project secret whose only
-- consumer is the sandbox browser, through
-- POST /v1/projects/:id/browser-logins/resolve. It never enters the env.
--
-- enum-value-checked: append-only value; no row uses it until the code that
-- writes it ships after this migration. IF NOT EXISTS keeps a faked or
-- re-baselined environment that already holds the value from failing, and
-- `pnpm --filter @kortix/db lint` checks the enum against kortix.ts.
ALTER TYPE "kortix"."project_secret_consumer" ADD VALUE IF NOT EXISTS 'browser';
