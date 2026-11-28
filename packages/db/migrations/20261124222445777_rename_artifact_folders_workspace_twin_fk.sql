-- Migration: rename_artifact_folders_workspace_twin_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- 20261123215124149_artifact_folders named the workspace twin of
-- artifact_folders.project_id `artifact_folders_workspace_fk`. Every other
-- twin is `<table>_project_id_workspaces_fk`, the name the workspace cutover
-- finds it by (packages/db/scripts/workspaces-twin-foreign-keys.integration.test.ts).
-- The rename takes a brief ACCESS EXCLUSIVE lock on artifact_folders, a table
-- created on 2026-11-23 that holds only the folders made since.
-- mixed-version-safe: no code reads or writes this constraint by name; the rename changes no column, row or check.
ALTER TABLE kortix.artifact_folders
  RENAME CONSTRAINT artifact_folders_workspace_fk TO artifact_folders_project_id_workspaces_fk;
