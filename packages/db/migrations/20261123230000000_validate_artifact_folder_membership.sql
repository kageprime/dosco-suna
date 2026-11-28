-- Validate separately: adding gallery_folder_id holds ACCESS EXCLUSIVE until commit.
-- The preceding concurrent index serves deletion; validation scans artifacts.
set lock_timeout = '2s';
set statement_timeout = '30min';
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE kortix.artifacts VALIDATE CONSTRAINT artifacts_gallery_folder_id_artifact_folders_folder_id_fk;
