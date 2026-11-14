-- Migration: role_assignments_workspace_scope
--
-- Workspaces Release 2a, step 7 (design.md §4): the engine reads the
-- WORKSPACE form of a grant. Release 2b step 11 rewrites every assignment to
-- `scope_type = 'workspace'`, `scope_id = <workspace id>`. R2a and R2b pods run
-- side by side, so this release (a) lets the table hold that form and (b)
-- reads it everywhere the account or project form is read. Nothing writes the
-- workspace form yet; no row is rewritten here.
--
-- The rule, one place in code (`apps/api/src/iam/workspace-scope.ts`) and the
-- same predicates here: a `workspace` row whose role is an account role
-- (`roles.scope_type = 'account'`) and that carries no object reads as an
-- `account` row on its `account_id`; every other `workspace` row reads as a
-- `project` row on `scope_id`. Today the canonical writer refuses a non-object
-- assignment whose scope differs from its role's (`iam/assignments.ts`), so the
-- role's scope decides without ambiguity.
--
-- This file:
--   1. Widens the four `role_assignments` CHECKs to accept 'workspace'
--      (NOT VALID; the next file validates them).
--   2. Extends the account guard trigger: a `workspace` row's `scope_id` must
--      be a workspace (or project) of its `account_id`, as a `project` row's is.
--   3. Redefines the three views that filter on `scope_type`
--      (`account_members`, `project_members`, `project_group_grants`) with the
--      same rule. Output columns are unchanged; CREATE OR REPLACE keeps each
--      view's OID, grants and INSTEAD OF triggers.
--   (`credit_accounts_owner_manage`, the RLS policy that reads owners, is its
--   own file: credit_accounts is a hot table.)
--
-- Not touched: the `scope_id -> projects(project_id)` foreign key. Release 2a
-- step 4 adds its twin into `workspaces(workspace_id)`; Release 2b drops the
-- old one BEFORE its rewrite (an account-scope row of a project-less workspace
-- names the account id, which is no project id).
--
-- mixed-version-safe: every predicate is the old one OR a disjunct that is
-- false for every existing row (no row has scope_type 'workspace'); old pods
-- never write the new value, and the widened checks accept every row the old
-- checks accepted.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- 1. The CHECKs. Existing rows satisfy the new forms by construction.
ALTER TABLE kortix.role_assignments DROP CONSTRAINT IF EXISTS role_assignments_scope_type_check;
ALTER TABLE kortix.role_assignments ADD CONSTRAINT role_assignments_scope_type_check
  CHECK (scope_type::text = ANY (ARRAY['account', 'project', 'workspace'])) NOT VALID;

-- Account rows keep scope_id NULL; project and workspace rows carry one.
ALTER TABLE kortix.role_assignments DROP CONSTRAINT IF EXISTS role_assignments_scope_shape_check;
ALTER TABLE kortix.role_assignments ADD CONSTRAINT role_assignments_scope_shape_check
  CHECK ((scope_type::text = 'account') = (scope_id IS NULL)) NOT VALID;

ALTER TABLE kortix.role_assignments DROP CONSTRAINT IF EXISTS role_assignments_object_shape_check;
ALTER TABLE kortix.role_assignments ADD CONSTRAINT role_assignments_object_shape_check
  CHECK ((object_type IS NULL AND object_id IS NULL)
      OR (object_type IS NOT NULL AND object_id IS NOT NULL AND scope_type::text = ANY (ARRAY['project', 'workspace']))) NOT VALID;

ALTER TABLE kortix.role_assignments DROP CONSTRAINT IF EXISTS role_assignments_project_principal_shape_check;
ALTER TABLE kortix.role_assignments ADD CONSTRAINT role_assignments_project_principal_shape_check
  CHECK (principal_type::text <> 'project'
      OR (object_type IS NOT NULL AND scope_type::text = ANY (ARRAY['project', 'workspace']) AND principal_id = scope_id)) NOT VALID;

-- 2. The account guard. A project row names a project of its account; a
-- workspace row names a workspace of its account (its project row today; a
-- project-less workspace's own row once R2b drops the projects foreign key).
CREATE OR REPLACE FUNCTION kortix.role_assignments_project_account_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.scope_type = 'project' AND NEW.scope_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kortix.projects
    WHERE project_id = NEW.scope_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'project % does not belong to account %', NEW.scope_id, NEW.account_id
      USING ERRCODE = '23503';
  END IF;
  IF NEW.scope_type = 'workspace' AND NOT EXISTS (
    SELECT 1 FROM kortix.projects
    WHERE project_id = NEW.scope_id AND account_id = NEW.account_id
  ) AND NOT EXISTS (
    SELECT 1 FROM kortix.workspaces
    WHERE workspace_id = NEW.scope_id AND legacy_account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'workspace % does not belong to account %', NEW.scope_id, NEW.account_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$fn$;

-- 3. The views. Each already filters on the role's own scope (`r.scope_type`)
-- and on `object_type IS NULL`, so the rule reduces to accepting 'workspace'.
CREATE OR REPLACE VIEW kortix.account_members AS
SELECT m.user_id,
    m.account_id,
    COALESCE((
      SELECT r.key::kortix.account_role AS key
        FROM kortix.role_assignments ra
        JOIN kortix.roles r ON r.role_id = ra.role_id
       WHERE ra.account_id = m.account_id
         AND ra.principal_type::text = 'user'
         AND ra.principal_id = m.user_id
         AND ra.scope_type::text = ANY (ARRAY['account', 'workspace'])
         AND ra.object_type IS NULL
         AND r.account_id IS NULL
         AND r.scope_type::text = 'account'
         AND (ra.expires_at IS NULL OR ra.expires_at > now())
       ORDER BY (CASE r.key WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END) DESC
       LIMIT 1), 'member'::kortix.account_role) AS account_role,
    m.joined_at,
    m.is_super_admin,
    m.scim_external_id
   FROM kortix.account_memberships m;

CREATE OR REPLACE VIEW kortix.project_members AS
SELECT DISTINCT ON (ra.scope_id, ra.principal_id) ra.account_id,
    ra.scope_id AS project_id,
    ra.principal_id AS user_id,
    r.key::kortix.project_role AS project_role,
    ra.granted_by,
    ra.created_at,
    ra.updated_at,
    ra.expires_at
   FROM kortix.role_assignments ra
   JOIN kortix.roles r ON r.role_id = ra.role_id
  WHERE ra.principal_type::text = 'user'
    AND ra.scope_type::text = ANY (ARRAY['project', 'workspace'])
    AND ra.object_type IS NULL
    AND r.account_id IS NULL
    AND r.scope_type::text = 'project'
    AND r.key::text = ANY (ARRAY['manager', 'member'])
  ORDER BY ra.scope_id, ra.principal_id, (CASE r.key WHEN 'manager' THEN 2 ELSE 1 END) DESC;

CREATE OR REPLACE VIEW kortix.project_group_grants AS
SELECT DISTINCT ON (ra.scope_id, ra.principal_id) ra.scope_id AS project_id,
    ra.principal_id AS group_id,
    ra.account_id,
    r.key::kortix.project_role AS role,
    ra.granted_by,
    ra.created_at,
    ra.updated_at,
    ra.expires_at
   FROM kortix.role_assignments ra
   JOIN kortix.roles r ON r.role_id = ra.role_id
  WHERE ra.principal_type::text = 'group'
    AND ra.scope_type::text = ANY (ARRAY['project', 'workspace'])
    AND ra.object_type IS NULL
    AND r.account_id IS NULL
    AND r.scope_type::text = 'project'
    AND r.key::text = ANY (ARRAY['manager', 'member'])
  ORDER BY ra.scope_id, ra.principal_id, (CASE r.key WHEN 'manager' THEN 2 ELSE 1 END) DESC;
