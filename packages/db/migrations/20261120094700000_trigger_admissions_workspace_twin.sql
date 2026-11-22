-- Migration: trigger_admissions_workspace_twin
-- Keep the workspace cutover's reference set complete for trigger admissions.
-- The existing projects FK keeps cascading deletes. This deferred NO ACTION
-- twin checks new writes after the project-to-workspace reconcile trigger runs.
-- NOT VALID avoids scanning historical admissions; validation belongs to R2b.
-- Mixed-version safe: no columns or existing constraints change.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_trigger_admissions
  ADD CONSTRAINT project_trigger_admissions_project_id_workspaces_fk
  FOREIGN KEY (project_id) REFERENCES kortix.workspaces (workspace_id)
  DEFERRABLE INITIALLY DEFERRED NOT VALID;
