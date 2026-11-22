-- Validate the two status checks 20261116153546027_eval_drop_pause_and_cancel_mode narrowed NOT VALID.
-- No row holds 'paused': only #12748's code wrote it, and that code is gone.
set lock_timeout = '2s';
set statement_timeout = '30s';
ALTER TABLE kortix.eval_jobs VALIDATE CONSTRAINT eval_jobs_status_check;
ALTER TABLE kortix.eval_trials VALIDATE CONSTRAINT eval_trials_status_check;
