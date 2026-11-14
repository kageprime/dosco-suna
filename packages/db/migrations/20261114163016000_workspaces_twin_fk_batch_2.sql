-- Migration: workspaces_twin_fk_batch_2
--
-- Workspaces Release 2a step 4, project side (design: .agents/skills/learnings/work/workspaces/design.md
-- §4). Each foreign key into kortix.projects(project_id) gets a twin into
-- kortix.workspaces(workspace_id): the workspace id IS the project id, and every project row
-- of any status has its workspaces row (prod read-only 2026-11-11: 0 project rows without
-- one). Release 3 drops the old foreign keys; the twins then carry the reference.
--
-- Tables (column, the old foreign key's ON DELETE):
--   chat_channel_bindings.project_id  (chat_channel_bindings_project_id_fkey, ON DELETE CASCADE)
--   chat_installs.project_id  (chat_installs_project_id_fkey, ON DELETE CASCADE)
--   chat_pending_auth_messages.project_id  (chat_pending_auth_messages_project_id_fkey, ON DELETE CASCADE)
--   chat_threads.project_id  (chat_threads_project_id_fkey, ON DELETE CASCADE)
--   config_release_failures.project_id  (config_release_failures_project_id_projects_project_id_fk, ON DELETE CASCADE)
--   config_release_heads.project_id  (config_release_heads_project_id_projects_project_id_fk, ON DELETE CASCADE)
--   config_releases.project_id  (config_releases_project_id_projects_project_id_fk, ON DELETE CASCADE)
--   connector_held_calls.project_id  (connector_held_calls_project_id_projects_project_id_fk, ON DELETE CASCADE)
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
-- (design.md §3.3). Cold tables: up to 8 per file.
--
-- Mixed-version deploy: the R1 image never names kortix.workspaces; the R1 triggers create
-- the workspaces row of every project row it inserts in the same statement, before commit.
--
-- ROLL BACK: a forward migration with ALTER TABLE ... DROP CONSTRAINT IF EXISTS <name> for
-- each twin below (ACCESS EXCLUSIVE on both tables, catalog only).
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE kortix.chat_channel_bindings
  ADD CONSTRAINT chat_channel_bindings_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.chat_installs
  ADD CONSTRAINT chat_installs_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.chat_pending_auth_messages
  ADD CONSTRAINT chat_pending_auth_messages_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.chat_threads
  ADD CONSTRAINT chat_threads_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.config_release_failures
  ADD CONSTRAINT config_release_failures_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.config_release_heads
  ADD CONSTRAINT config_release_heads_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.config_releases
  ADD CONSTRAINT config_releases_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE kortix.connector_held_calls
  ADD CONSTRAINT connector_held_calls_project_id_workspaces_fk FOREIGN KEY (project_id)
  REFERENCES kortix.workspaces (workspace_id) DEFERRABLE INITIALLY DEFERRED NOT VALID;
