-- Migration: role_assignments_workspace_scope_validate
--
-- Workspaces Release 2a, step 7: validate the four widened `role_assignments`
-- CHECKs added NOT VALID by 20261114162256000_role_assignments_workspace_scope.
-- Every existing row passed the narrower checks they replace, and each new
-- check accepts a superset of what the old one accepted, so no row can fail.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue.

set lock_timeout = '2s';
set statement_timeout = '120s';

ALTER TABLE kortix.role_assignments VALIDATE CONSTRAINT role_assignments_scope_type_check;
ALTER TABLE kortix.role_assignments VALIDATE CONSTRAINT role_assignments_scope_shape_check;
ALTER TABLE kortix.role_assignments VALIDATE CONSTRAINT role_assignments_object_shape_check;
ALTER TABLE kortix.role_assignments VALIDATE CONSTRAINT role_assignments_project_principal_shape_check;
