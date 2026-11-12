-- Migration: freeze_legacy_suna_tables
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Every table this touches is a Suna-era table no current code writes (prod 2026-11-10: 0 writes
-- in a 90 s sample; the only daily writer is the cron job unscheduled below) or the new, empty
-- kortix.contact_forms. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each legacy table for an
-- instant; nothing live waits behind it.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Freeze the Suna-era tables before they are dropped (drop_legacy_suna_schemas.sql.pending, after
-- the backup): all app data lives in the kortix schema. In order:
--   1. public.contact_forms moves to kortix.contact_forms (rows copied, trigger moved). Until the
--      new web route is everywhere, an insert into the old table is mirrored to the new one.
--   2. Every other table in public and basejump refuses INSERT and UPDATE, so a writer nobody
--      found fails loudly. DELETE stays allowed: account deletion and the ON DELETE actions from
--      auth.users and basejump.accounts keep working. A foreign-key action (a nested trigger) and
--      a transaction that sets kortix.legacy_write = 'on' (account deletion's NULLing of
--      references) pass.
--   3. anon and authenticated lose their table privileges on public and basejump. On 2026-11-05 a
--      new sign-up read ~4,900 pages of public.messages through PostgREST: the old RLS shows every
--      row of a project or thread marked is_public to any role. No current client reads these
--      tables through PostgREST (the web writes with the service role).
--   4. The pg_cron job yearly-plan-monthly-refill stops: it writes only public.credit_* (search
--      path "$user", public); yearly plans are refilled by the API's billing-yearly-rotation job.
--   5. The welcome-email trigger on auth.users goes: it posts to /v1/webhooks/user-created, a
--      route the API no longer serves.
-- mixed-version-safe: the old web still inserts into public.contact_forms with the service role, which keeps INSERT and is mirrored into kortix.contact_forms; no deployed API image inserts into or updates a legacy table except account deletion's NULLing, which an old image does without kortix.legacy_write and so fails for that one request until the new image is live (it is retried by the sweep).

-- ── 1. kortix.contact_forms ───────────────────────────────────────────────────
-- backfill-safe: public.contact_forms holds 170 rows on prod (2026-11-10, newest 2026-11-02); kortix.contact_forms is new and has no writer before this commit, and the copy holds only ACCESS SHARE on the old table.
DO $$
BEGIN
  IF to_regclass('public.contact_forms') IS NOT NULL THEN
    INSERT INTO kortix.contact_forms (id, created_at, data)
    SELECT id, created_at, data FROM public.contact_forms
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- After the copy, so the copied rows do not enqueue a second Sales event.
CREATE TRIGGER sales_demo_requested AFTER INSERT ON kortix.contact_forms
FOR EACH ROW EXECUTE FUNCTION kortix.enqueue_demo_requested();

CREATE FUNCTION kortix.mirror_legacy_contact_form() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- The kortix row's own trigger enqueues the Sales event; the old table's trigger then finds
  -- the same event id and does nothing (ON CONFLICT in kortix.enqueue_demo_requested).
  INSERT INTO kortix.contact_forms (id, created_at, data)
  VALUES (NEW.id, NEW.created_at, NEW.data)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.contact_forms') IS NOT NULL THEN
    CREATE TRIGGER mirror_to_kortix_contact_forms AFTER INSERT ON public.contact_forms
    FOR EACH ROW EXECUTE FUNCTION kortix.mirror_legacy_contact_form();
  END IF;
END $$;

-- ── 2. Refuse INSERT and UPDATE on every other legacy table ───────────────────
CREATE FUNCTION kortix.reject_legacy_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- pg_trigger_depth() > 1: a foreign-key action (ON DELETE SET NULL from auth.users or
  -- basejump.accounts) or another trigger that an allowed DELETE fired.
  IF pg_catalog.pg_trigger_depth() > 1 OR pg_catalog.current_setting('kortix.legacy_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'read_only_sql_transaction',
    MESSAGE = pg_catalog.format('%I.%I is a frozen Suna-era table: %s refused', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP),
    HINT = 'App data lives in the kortix schema. DELETE is allowed; packages/db/migrations-pending/drop_legacy_suna_schemas.sql.pending drops the table.';
END;
$$;

-- Idempotent, so a test that builds legacy tables after the migrations can freeze them too.
CREATE FUNCTION kortix.freeze_legacy_tables() RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  t regclass;
  frozen integer := 0;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace IN (pg_catalog.to_regnamespace('public'), pg_catalog.to_regnamespace('basejump'))
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND c.oid IS DISTINCT FROM pg_catalog.to_regclass('public.contact_forms')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e
                        WHERE e.classid = 'pg_catalog.pg_class'::regclass AND e.objid = c.oid AND e.deptype = 'e')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'kortix_legacy_freeze')
     ORDER BY 1
  LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER kortix_legacy_freeze BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION kortix.reject_legacy_write()', t);
    frozen := frozen + 1;
  END LOOP;
  RETURN frozen;
END;
$$;

SELECT kortix.freeze_legacy_tables();

-- ── 3. No PostgREST access to the legacy tables ───────────────────────────────
DO $$
BEGIN
  IF to_regnamespace('basejump') IS NOT NULL THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA basejump FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA basejump FROM anon, authenticated;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- ── 4. The legacy yearly-refill cron job ──────────────────────────────────────
DO $$
DECLARE
  scheduled boolean;
BEGIN
  -- Dynamic SQL: a database without pg_cron (self-host, local) has no cron.job to plan against.
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1)' INTO scheduled USING 'yearly-plan-monthly-refill';
    IF scheduled THEN
      EXECUTE 'SELECT cron.unschedule($1)' USING 'yearly-plan-monthly-refill';
    END IF;
  END IF;
END $$;

-- ── 5. The welcome-email trigger ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS on_auth_user_created_webhook ON auth.users;
  END IF;
  DROP FUNCTION IF EXISTS public.trigger_welcome_email();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[freeze-legacy] no privilege to drop the auth.users welcome trigger: drop it manually';
END $$;
