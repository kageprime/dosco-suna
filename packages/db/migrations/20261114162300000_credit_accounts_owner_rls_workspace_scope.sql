-- Migration: credit_accounts_owner_rls_workspace_scope
--
-- Workspaces Release 2a, step 7: the RLS policy that lets an account owner
-- read and manage its wallet row through PostgREST reads the owner grant in
-- the workspace form too (`scope_type = 'workspace'`, see
-- 20261114162256000_role_assignments_workspace_scope). The policy already
-- requires the role's own scope to be 'account' and no object, so the rule
-- reduces to accepting 'workspace'. Its own file: credit_accounts is hot, and
-- ALTER POLICY takes a short ACCESS EXCLUSIVE lock on it.
--
-- mixed-version-safe: the new USING is the old one OR a disjunct that is false
-- for every existing row; no row has scope_type 'workspace' until Release 2b.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER POLICY credit_accounts_owner_manage ON kortix.credit_accounts
  USING (EXISTS (
    SELECT 1
      FROM kortix.role_assignments ra
      JOIN kortix.roles r ON r.role_id = ra.role_id
     WHERE ra.account_id = credit_accounts.account_id
       AND ra.principal_type::text = 'user'
       AND ra.principal_id = (SELECT auth.uid() AS uid)
       AND ra.scope_type::text = ANY (ARRAY['account', 'workspace'])
       AND ra.object_type IS NULL
       AND r.account_id IS NULL
       AND r.scope_type::text = 'account'
       AND r.key::text = 'owner'
       AND (ra.expires_at IS NULL OR ra.expires_at > now())));
