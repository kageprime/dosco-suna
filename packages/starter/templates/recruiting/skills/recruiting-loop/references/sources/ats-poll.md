# Source: ATS poll

Trigger `recruiting-ats-poll` (cron, at :10 and :40 every hour, keyed
session). Disabled by default. Turn it on when `record.kind` is an ATS whose
webhooks cannot send `Authorization: Bearer` (the record reference says so)
and no relay sits in front of it. It reads only.

## Cursor

The cursor is the `created_at` of the newest application the last pass saw.
It lives in the keyed session's own file `/tmp/recruiting/ats-poll/cursor`,
and as a fallback in the newest `[recruiting-loop] screened` note's time. No
cursor: start 24 hours back. Never start further back than 7 days without a
person asking: an old backlog floods the Review page.

## Run

1. `record.context`. `job.list()`; keep the jobs mapped in `roles[].ats_job_id`
   with `open: true`.
2. `application.list(since=<cursor>)` into a file. Keep applications for the
   mapped jobs only, in an active stage.
3. For each application, oldest first, up to `caps.screens_per_day` for the
   day: compute the key, `note.list` on the candidate. A `screened` note with
   the key: skip. Otherwise run contract §5 from step 3, with the CV and
   answers from `application.get`.
4. Move the cursor to the newest `created_at` seen. Over the cap: move it to
   the newest application screened, so the next pass continues there.
5. Delete the application files under `/tmp/recruiting/`.
6. End with `recruiting-ats-poll:` and the contract run line.
