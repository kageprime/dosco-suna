-- Validate the visibility check 20261118114157651_session_groups_sharing_and_tabs
-- added NOT VALID. Every row holds 'private' (the column default) or a value the
-- API wrote through the same check.
set lock_timeout = '2s';
set statement_timeout = '30s';
ALTER TABLE kortix.project_session_groups VALIDATE CONSTRAINT project_session_groups_visibility_check;
