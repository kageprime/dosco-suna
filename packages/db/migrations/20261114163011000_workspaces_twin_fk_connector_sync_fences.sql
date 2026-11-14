-- Migration: workspaces_twin_fk_connector_sync_fences
--
-- Workspaces Release 2a step 4, project side (design: .agents/skills/learnings/work/workspaces/design.md
-- §4). Each foreign key into kortix.projects(project_id) gets a twin into
-- kortix.workspaces(workspace_id): the workspace id IS the project id, and every project row
-- of any status has its workspaces row (prod read-only 2026-11-11: 0 project rows without
-- one). Release 3 drops the old foreign keys; the twins then carry the reference.
--
-- Table (column, the old foreign key's ON DELETE):
--   connector_sync_fences.project_id  (connector_sync_fences_project_id_projects_project_id_fk, ON DELETE CASCADE)
--
-- Every twin is NOT VALID, NO ACTION, DEFERRABLE INITIALLY DEFERRED:
--   - NO ACTION: the old foreign key keeps the ON DELETE action. While the R1 reconcile
--     triggers derive kortix.workspaces, a twin must never act on a workspaces row change
--     (a CASCADE twin would delete sessions if a reconcile ever deleted a live row). A stray
--     delete of a referenced row fails the writer's transaction instead. Release 2b, after
--     the reconcile triggers are gone, re-creates each twin with its final ON DELETE action
--     and validates it once.
--   - DEFERRABLE INITIALLY DEFERRED: the check runs at commit, after the AFTER triggers that
--     write the workspaces row in the same transaction. Referential actions are not affected.
--   - NOT VALID: no scan of existing rows here (squawk adding-foreign-key-constraint). Rows
--     written from now on are checked.
--
-- Locks: ADD FOREIGN KEY takes SHARE ROW EXCLUSIVE on the child and on kortix.workspaces for
-- the catalog change only (NOT VALID reads no rows). lock_timeout 3s: a 55P03 rolls this
-- file back; find the holder in pg_stat_activity and rerun, never raise the timeout
-- (design.md §3.3). A hot table: alone in its file.
--
-- Mixed-version deploy: the R1 image never names kortix.workspaces; the R1 triggers create
-- the workspaces row of every project row it inserts in the same statement, before commit.
--
-- ROLL BACK: a forward migration with ALTER TABLE ... DROP CONSTRAINT IF EXISTS <name> for
-- each twin below (ACCESS EXCLUSIVE on both tables, catalog only).
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE kortix.connector_sync_fences
  ADD CONSTRAINT connector_sync_fences_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
