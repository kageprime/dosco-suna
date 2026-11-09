-- Migration: gateway_logs_project_session_time_restore_name
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- KRTX-4023, final step of the session-time replace dance. The replacement
-- index built by 20261108090000400 (the old one dropped by
-- 20261108090000600) takes back the canonical name the drizzle schema
-- contract declares (packages/db/src/schema/kortix.ts declares it by relation
-- only; INCLUDE lists and the partial predicate are inexpressible there).
--
-- The project-time covering index keeps its versioned name
-- (idx_gateway_logs_project_time_covering_v4, built by 20261108090000300):
-- the trunk's v2/v3 rebuilds (KRTX-4022, KRTX-4449) moved that index to
-- versioned names, and v4 follows them.
--
-- mixed-version-safe: this renames the index 20261108090000400 built; the
-- planner matches indexes by definition, never by name, and no code
-- references index names, so old and new code are served identically before
-- and after the rename. ALTER INDEX ... RENAME is a catalog-only change
-- under a brief lock on the index itself.

ALTER INDEX IF EXISTS "kortix"."idx_gateway_logs_project_session_time_llm"
  RENAME TO "idx_gateway_logs_project_session_time";
