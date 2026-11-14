-- Migration: drop_legacy_suna_schemas
--
-- Drops the Suna-era data: every table, view, sequence, function and type in
-- `public` that no extension owns, and the schemas `basejump`, `kortix_yolo`,
-- `drizzle` and (staging only) `legacy_staging_prebaseline`. Prod, 2026-11-12:
-- `public` 224.4 GB (messages 115, documents 46, agent_runs 28,
-- webhook_events 18, the rest under 5 each), `basejump` 0.3 GB. Kortix data
-- lives in `kortix` (plus `kortix_wallet` functions); no deployed code reads
-- or writes these schemas.
--
-- Preconditions (all hold, 2026-11-12):
--   0. 20261110135954872_freeze_legacy_suna_tables is applied on dev, staging
--      and prod (prod 2026-11-10, v0.15.5): every legacy table refuses writes,
--      anon/authenticated lost their privileges, leads go to
--      kortix.contact_forms.
--   1. Backup: one full pg_dump of public + basejump + kortix_yolo + drizzle of
--      prod in s3://kortix-prod-legacy-suna-backup/20261110/ (no expiry,
--      versioned, SSE-KMS). The restore test passed: 77 tables, 80,467,825
--      rows. Dev and staging get no backup (decided 2026-11-11).
--   2. Suna-era Stripe subscriptions: no action (decided 2026-11-10). Their
--      owners exist only in basejump.account_user, so owner-alerts loses its
--      legacy fallback in the same change.
--   3. The public.atomic_* wallet wrappers have no caller: the wallet calls
--      kortix_wallet.* directly. The function loop below drops them.
--   4. Self-host `:stable` (v0.15.6) has the migrate.ts bootstrap check on
--      kortix.accounts (first in v0.15.4), so a later `migrate` does not
--      re-run 0000_bootstrap.sql on a database without basejump.
--
-- Lock and time: DROP TABLE takes ACCESS EXCLUSIVE on each legacy table
-- (frozen, no reader) and a short lock on auth.users for the foreign keys the
-- legacy tables hold there. If the 2 s lock_timeout fires, the whole
-- migration rolls back: re-run the deploy step, never raise the timeout. The
-- guard below refuses to run if any object outside the legacy schemas still
-- depends on them, so the CASCADEs cannot remove a live object. The files
-- (~225 GB on prod) are unlinked at commit.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: no deployed API or web image reads or writes public.* or basejump.* once preconditions 0 and 2 hold; account deletion's legacy branches check to_regclass and skip a missing table.

-- The 'recordings' bucket holds 0 objects and no code names it; its policies call basejump.get_accounts_with_role().
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Account members can select recording files" ON storage.objects;
    DROP POLICY IF EXISTS "Account members can insert recording files" ON storage.objects;
    DROP POLICY IF EXISTS "Account members can update recording files" ON storage.objects;
    DROP POLICY IF EXISTS "Account members can delete recording files" ON storage.objects;
    -- Dev only: the Suna support-ticket attachments policy reads basejump and public.support_tickets.
    DROP POLICY IF EXISTS "Users can view their ticket attachments" ON storage.objects;
  END IF;
END $$;

-- pg_cron jobs that call a legacy public function by its unqualified name (pg_depend does not
-- see them). Prod has none; staging has cleanup-expired-staged-files; dev has
-- categorize-stale-projects and generate-taxonomy-daily. After the drop they would fail every run.
DO $$
DECLARE
  job text;
  scheduled boolean;
BEGIN
  -- Dynamic SQL: a database without pg_cron (self-host, local) has no cron.job to plan against.
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOREACH job IN ARRAY ARRAY['cleanup-expired-staged-files', 'categorize-stale-projects', 'generate-taxonomy-daily'] LOOP
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1)' INTO scheduled USING job;
      IF scheduled THEN
        EXECUTE 'SELECT cron.unschedule($1)' USING job;
      END IF;
    END LOOP;
  END IF;
END $$;

-- A lead the old web route wrote after the freeze was mirrored already; copy any row the mirror missed.
-- backfill-safe: public.contact_forms holds ~170 rows and has had no writer since precondition 0.
DO $$
BEGIN
  IF to_regclass('public.contact_forms') IS NOT NULL THEN
    INSERT INTO kortix.contact_forms (id, created_at, data)
    SELECT id, created_at, data FROM public.contact_forms
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- Guard: refuse if anything outside the legacy schemas still depends on them.
-- A rule, trigger, policy, constraint or column default has no schema of its own in
-- pg_identify_object: it belongs to its relation's schema (a kortix view's _RETURN rule).
DO $$
DECLARE
  blockers text;
BEGIN
  WITH dep AS (
    SELECT d.*,
           coalesce(
             CASE d.classid
               WHEN 'pg_rewrite'::regclass THEN (SELECT c.relnamespace::regnamespace::text FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
               WHEN 'pg_trigger'::regclass THEN (SELECT c.relnamespace::regnamespace::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.oid = d.objid)
               WHEN 'pg_policy'::regclass THEN (SELECT c.relnamespace::regnamespace::text FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
               WHEN 'pg_attrdef'::regclass THEN (SELECT c.relnamespace::regnamespace::text FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
               WHEN 'pg_constraint'::regclass THEN (SELECT coalesce(c.relnamespace, t.typnamespace, k.connamespace)::regnamespace::text
                                                      FROM pg_constraint k LEFT JOIN pg_class c ON c.oid = k.conrelid LEFT JOIN pg_type t ON t.oid = k.contypid
                                                     WHERE k.oid = d.objid)
             END,
             (pg_identify_object(d.classid, d.objid, d.objsubid)).schema) AS dependent_schema,
           (pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema AS referenced_schema,
           (pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).identity AS referenced
      FROM pg_depend d
     WHERE d.deptype IN ('n', 'a')
       -- A table in a publication is removed from it by DROP TABLE.
       AND d.classid <> 'pg_publication_rel'::regclass)
  SELECT string_agg(DISTINCT format('%s -> %s', pg_describe_object(classid, objid, objsubid), referenced), '; ')
    INTO blockers
    FROM dep
   WHERE referenced_schema IN ('public', 'basejump', 'kortix_yolo', 'drizzle', 'legacy_staging_prebaseline')
     AND coalesce(dependent_schema, '') NOT IN ('public', 'basejump', 'kortix_yolo', 'drizzle', 'legacy_staging_prebaseline', '')
     -- Extensions installed in public (vector, pg_trgm on prod) stay, with every object they own.
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = dep.refclassid AND e.objid = dep.refobjid AND e.deptype = 'e');
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION 'drop_legacy_suna_schemas: objects outside public/basejump still depend on them: %', blockers;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, '; ')
    INTO blockers
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname LIKE 'kortix%'
     AND p.oid NOT IN (to_regprocedure('kortix.freeze_legacy_tables()'), to_regprocedure('kortix.reject_legacy_write()'))
     AND p.prosrc ~ '\m(public|basejump)\.';
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION 'drop_legacy_suna_schemas: kortix functions still name a legacy object: %', blockers;
  END IF;
END $$;

-- public: every view, table, sequence, function and type that no extension owns. The extensions
-- in public (vector, pg_trgm on prod) stay.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS name, c.relkind
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('v', 'm')
       AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
  LOOP
    IF r.relkind = 'm' THEN
      EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS %s CASCADE', r.name);
    ELSE
      EXECUTE format('DROP VIEW IF EXISTS %s CASCADE', r.name);
    END IF;
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass AS name
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', r.name);
  END LOOP;

  -- Sequences no table owns (an owned one went with its table).
  FOR r IN
    SELECT c.oid::regclass AS name
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'S'
       AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_class'::regclass AND e.objid = c.oid AND e.deptype IN ('e', 'a', 'i'))
  LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS %s CASCADE', r.name);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS name, p.prokind
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
  LOOP
    EXECUTE format('DROP %s IF EXISTS %s CASCADE', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.name);
  END LOOP;

  FOR r IN
    SELECT t.oid::regtype AS name
      FROM pg_type t
     WHERE t.typnamespace = 'public'::regnamespace
       AND t.typtype IN ('e', 'd', 'c')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_type'::regclass AND e.objid = t.oid AND e.deptype = 'e')
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS %s CASCADE', r.name);
  END LOOP;
END $$;

DROP SCHEMA IF EXISTS basejump CASCADE;
DROP SCHEMA IF EXISTS kortix_yolo CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;
-- Staging only: two pre-baseline Suna billing tables (~58 MB) with a foreign key into public.credit_accounts.
DROP SCHEMA IF EXISTS legacy_staging_prebaseline CASCADE;

-- The freeze has nothing left to guard.
DROP FUNCTION IF EXISTS kortix.freeze_legacy_tables();
DROP FUNCTION IF EXISTS kortix.reject_legacy_write();
DROP FUNCTION IF EXISTS kortix.mirror_legacy_contact_form();
