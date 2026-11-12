-- Migration: workspaces_reconcile_in_place
--
-- Workspaces Release 2a prerequisite (design: .agents/skills/learnings/work/workspaces/design.md §4
-- step 4, "Reconcile in place"). Replaces the body of kortix.workspaces_reconcile_account (M4,
-- 20261106153100000_workspaces_table.sql). Same signature, same end state: the table still equals
-- kortix.workspaces_expected for the account after every call (I9).
--
-- What changes: the M4 body deleted every row of the account that differed from its expected row
-- and inserted it again. A rename, an open (last_opened_at), a settings write, a deletion request
-- or an archive deleted the live row; a transfer or a split move deleted the moved project's row
-- when the source account was reconciled first. Nothing references kortix.workspaces in Release 1,
-- so that was invisible. Release 2a adds foreign keys INTO kortix.workspaces: each such delete would
-- then cascade into, or be refused by, every row that references the workspace. This body:
--
--   1. A row of the account that is no longer expected here:
--      a. its project row now belongs to another account (a transfer, the split): it stays, as a
--         tombstone of this account, so it leaves this account's live slot. The other account's
--         reconcile (the same trigger, the same statement) claims it in place.
--      b. otherwise (its project row is gone, it is the project-less row of an account whose
--         project took over, or the account is gone): it is deleted, as before.
--   2. The expected rows are upserted in place (ON CONFLICT (workspace_id) DO UPDATE): first the
--      rows that leave the live slot (tombstones, split_pending), then the rest, so the one live
--      row never meets a stale one on uq_workspaces_live_account. That collision is why M4 deleted
--      first.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- CREATE OR REPLACE FUNCTION takes no table lock. A transaction that runs the old body keeps it
-- until it commits; both bodies end in the same table state, so old and new pods can run side by
-- side. Proof: apps/api/src/workspaces/reconcile-in-place.integration.test.ts (a canary table
-- references each row ON DELETE CASCADE).
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.workspaces_reconcile_account(p_account_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_before uuid;
  v_after uuid;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM kortix.accounts a WHERE a.account_id = p_account_id FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('kortix:workspaces:' || p_account_id::text, 0));

  v_before := kortix.workspace_id_of_account(p_account_id);

  -- 1a. A project row that moved to another account: a tombstone of this account until that
  -- account's reconcile claims it. It leaves this account's live slot now.
  UPDATE kortix.workspaces w
     SET legacy_account_id = NULL, former_account_id = p_account_id, lifecycle = 'tombstone',
         split_pending = false, synced_at = now()
   WHERE w.legacy_account_id = p_account_id
     AND NOT EXISTS (SELECT 1 FROM kortix.workspaces_expected(p_account_id) e WHERE e.workspace_id = w.workspace_id)
     AND EXISTS (SELECT 1 FROM kortix.projects pr WHERE pr.project_id = w.workspace_id AND pr.account_id <> p_account_id);

  -- 1b. Every other row of this account that is no longer expected: its project row is gone, it
  -- is the project-less row the account's first project replaced, or the account is gone.
  DELETE FROM kortix.workspaces w
   WHERE (w.legacy_account_id = p_account_id OR w.former_account_id = p_account_id)
     AND NOT EXISTS (SELECT 1 FROM kortix.workspaces_expected(p_account_id) e WHERE e.workspace_id = w.workspace_id)
     AND NOT EXISTS (SELECT 1 FROM kortix.projects pr WHERE pr.project_id = w.workspace_id AND pr.account_id <> p_account_id);

  -- 2. The expected rows, in place. A conflict on a row of another account is a project row that
  -- moved here: it moves to this account. Rows leaving the live slot go first.
  INSERT INTO kortix.workspaces AS w
  SELECT * FROM kortix.workspaces_expected(p_account_id) e
   WHERE e.lifecycle = 'tombstone' OR e.split_pending
  ON CONFLICT (workspace_id) DO UPDATE
     SET legacy_account_id = EXCLUDED.legacy_account_id,
         former_account_id = EXCLUDED.former_account_id,
         project_id = EXCLUDED.project_id,
         lifecycle = EXCLUDED.lifecycle,
         split_pending = EXCLUDED.split_pending,
         name = EXCLUDED.name,
         repo_url = EXCLUDED.repo_url,
         default_branch = EXCLUDED.default_branch,
         manifest_path = EXCLUDED.manifest_path,
         secret_default_strategy = EXCLUDED.secret_default_strategy,
         metadata = EXCLUDED.metadata,
         sandbox_provider_generation = EXCLUDED.sandbox_provider_generation,
         idempotency_key = EXCLUDED.idempotency_key,
         last_opened_at = EXCLUDED.last_opened_at,
         project_status = EXCLUDED.project_status,
         setup_complete_at = EXCLUDED.setup_complete_at,
         setup_wizard_step = EXCLUDED.setup_wizard_step,
         mfa_required = EXCLUDED.mfa_required,
         session_max_lifetime_minutes = EXCLUDED.session_max_lifetime_minutes,
         session_idle_timeout_minutes = EXCLUDED.session_idle_timeout_minutes,
         pat_max_lifetime_days = EXCLUDED.pat_max_lifetime_days,
         pat_require_expiry = EXCLUDED.pat_require_expiry,
         pat_idle_revoke_days = EXCLUDED.pat_idle_revoke_days,
         admins_see_all_sessions = EXCLUDED.admins_see_all_sessions,
         automations_paused_at = EXCLUDED.automations_paused_at,
         automations_paused_by = EXCLUDED.automations_paused_by,
         branding = EXCLUDED.branding,
         deletion_scheduled_for = EXCLUDED.deletion_scheduled_for,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         synced_at = EXCLUDED.synced_at
   WHERE (to_jsonb(w.*) - 'synced_at') IS DISTINCT FROM (to_jsonb(EXCLUDED.*) - 'synced_at');

  INSERT INTO kortix.workspaces AS w
  SELECT * FROM kortix.workspaces_expected(p_account_id) e
   WHERE NOT (e.lifecycle = 'tombstone' OR e.split_pending)
  ON CONFLICT (workspace_id) DO UPDATE
     SET legacy_account_id = EXCLUDED.legacy_account_id,
         former_account_id = EXCLUDED.former_account_id,
         project_id = EXCLUDED.project_id,
         lifecycle = EXCLUDED.lifecycle,
         split_pending = EXCLUDED.split_pending,
         name = EXCLUDED.name,
         repo_url = EXCLUDED.repo_url,
         default_branch = EXCLUDED.default_branch,
         manifest_path = EXCLUDED.manifest_path,
         secret_default_strategy = EXCLUDED.secret_default_strategy,
         metadata = EXCLUDED.metadata,
         sandbox_provider_generation = EXCLUDED.sandbox_provider_generation,
         idempotency_key = EXCLUDED.idempotency_key,
         last_opened_at = EXCLUDED.last_opened_at,
         project_status = EXCLUDED.project_status,
         setup_complete_at = EXCLUDED.setup_complete_at,
         setup_wizard_step = EXCLUDED.setup_wizard_step,
         mfa_required = EXCLUDED.mfa_required,
         session_max_lifetime_minutes = EXCLUDED.session_max_lifetime_minutes,
         session_idle_timeout_minutes = EXCLUDED.session_idle_timeout_minutes,
         pat_max_lifetime_days = EXCLUDED.pat_max_lifetime_days,
         pat_require_expiry = EXCLUDED.pat_require_expiry,
         pat_idle_revoke_days = EXCLUDED.pat_idle_revoke_days,
         admins_see_all_sessions = EXCLUDED.admins_see_all_sessions,
         automations_paused_at = EXCLUDED.automations_paused_at,
         automations_paused_by = EXCLUDED.automations_paused_by,
         branding = EXCLUDED.branding,
         deletion_scheduled_for = EXCLUDED.deletion_scheduled_for,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         synced_at = EXCLUDED.synced_at
   WHERE (to_jsonb(w.*) - 'synced_at') IS DISTINCT FROM (to_jsonb(EXCLUDED.*) - 'synced_at');

  v_after := kortix.workspace_id_of_account(p_account_id);
  -- A live id that moves from one id to another (the dormant row of a new account to its first
  -- project) re-stamps the account's expand rows. A move from NULL (split_pending, or no row yet)
  -- is left to the split runner and the M8 fill: a keeper account can hold millions of ledger rows.
  IF v_before IS NOT NULL AND v_after IS NOT NULL AND v_before <> v_after THEN
    PERFORM kortix.workspace_fill_account(p_account_id);
  END IF;
END;
$$;
