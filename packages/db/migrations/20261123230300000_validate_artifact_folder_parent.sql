-- Validate separately: adding parent_folder_id held ACCESS EXCLUSIVE until commit.
-- Every pre-existing row has a NULL parent, so the scan finds no violation.
set lock_timeout = '2s';
set statement_timeout = '30min';
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE kortix.artifact_folders VALIDATE CONSTRAINT artifact_folders_parent_folder_id_artifact_folders_folder_id_fk;
