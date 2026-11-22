-- R2a twins stay SQL-managed: Drizzle cannot express deferred foreign keys.
-- Keep the original projects FK and its cascade until the R2b cutover.
-- NOT VALID avoids scanning reservations; R2b validates all twins after replacing their actions.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_trigger_admissions
  ADD CONSTRAINT project_trigger_admissions_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) ON DELETE NO ACTION
  DEFERRABLE INITIALLY DEFERRED NOT VALID;
