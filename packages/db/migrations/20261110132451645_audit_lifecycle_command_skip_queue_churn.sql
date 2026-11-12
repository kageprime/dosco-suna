-- Migration: audit_lifecycle_command_skip_queue_churn
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The lifecycle command audit records a prompt's creation and its outcome, not
-- the queue's own churn.
--
-- `audit_session_lifecycle_command` wrote one `kortix.audit_events` row per
-- status/attempts change. A queued prompt that waits behind another one is
-- claimed (`queued` -> `running`, attempts + 1) and put back (`running` ->
-- `queued`, attempts - 1) every time a drain looks at it, and the dedupe index
-- includes `occurred_at`, so every cycle wrote two new rows. Prod 2026-11-07:
-- 12.1M rows in one day (~15 GB) from ~500 prompts of 2 sessions.
--
-- Now an UPDATE that stays between `queued` and `running` writes no row: a
-- claim, a reclaim, an admission put-back, a park, a backoff retry. The INSERT
-- (`queued`) and every change into or out of an outcome (`succeeded`,
-- `failed`, `dead_lettered`, and a retry of one) are still recorded.
-- `shared/audit-reconciliation.ts` stops projecting `running` rows to match.
--
-- CREATE OR REPLACE FUNCTION only: no table lock, and old API tasks read no
-- audit row this stops writing.
CREATE OR REPLACE FUNCTION kortix.audit_session_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
DECLARE
  event_outcome text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status::text IN ('queued', 'running')
     AND NEW.status::text IN ('queued', 'running') THEN RETURN NEW; END IF;
  event_outcome := CASE NEW.status::text
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'pending'
    WHEN 'succeeded' THEN 'success'
    ELSE 'failure' END;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase, resource_type, resource_id,
    execution_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, output_sha256, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.actor_user_id,
    CASE WHEN NEW.source IN ('trigger', 'schedule', 'system') THEN 'system' ELSE 'human' END,
    CASE WHEN NEW.source IN ('trigger', 'schedule') THEN 'automation' ELSE NEW.source END,
    event_outcome, 'session.lifecycle.' || NEW.command_type, NEW.status::text,
    'session_lifecycle_command', NEW.command_id::text, NEW.command_id::text,
    'session_lifecycle_commands', NEW.command_id::text,
    NEW.status::text || ':' || NEW.attempts::text,
    jsonb_build_object('command_type', NEW.command_type, 'source', NEW.source, 'attempts', NEW.attempts),
    jsonb_build_object('has_result', NEW.result IS NOT NULL, 'has_error', NEW.last_error IS NOT NULL),
    CASE WHEN NEW.result IS NULL AND NEW.last_error IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(COALESCE(NEW.result::text, NEW.last_error), 'UTF8'), 'sha256'), 'hex') END,
    COALESCE(NEW.updated_at, NEW.created_at)
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
