-- Validate the three checks 20261114180027000_eval_pause_and_soft_cancel added NOT VALID.
-- Every existing row already satisfies them: the status checks only widen, and
-- cancel_mode is null on every row from before that migration.
set lock_timeout = '2s';
set statement_timeout = '30s';
ALTER TABLE kortix.eval_jobs VALIDATE CONSTRAINT eval_jobs_cancel_mode_check;
ALTER TABLE kortix.eval_jobs VALIDATE CONSTRAINT eval_jobs_status_check;
ALTER TABLE kortix.eval_trials VALIDATE CONSTRAINT eval_trials_status_check;
