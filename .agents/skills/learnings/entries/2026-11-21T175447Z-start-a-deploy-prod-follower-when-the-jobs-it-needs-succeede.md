---
recorded: 2026-11-21T17:54:47Z
incident_date: 2026-11-18
---
# Start a Deploy Prod follower when the jobs it needs succeeded, not only when the whole run is green

**Rule:** A workflow that follows `Deploy Prod` (`workflow_run`) starts when the jobs it needs succeeded,
not only when the whole run concluded `success`. A best-effort job that fails (the Kortix
Capture or desktop installer builds) must not hold back an unrelated release step.

**Trigger surface:** Adding or editing a `workflow_run` follower of `Deploy Prod`, or adding a best-effort job to
`deploy-prod.yml`.

**Incident:** v0.16.0 (2026-11-18) to v0.16.3 (2026-11-21): the Capture installer builds failed on every
`Deploy Prod`, so each run concluded `failure` although prod was live. `Mobile OTA` and
`Mobile Store` required `conclusion == 'success'` and were skipped 4 releases in a row: no
production OTA, and mobile 1.6.48 reached the stores only through a manual dispatch on
2026-11-20. Nobody saw it for 3 days: a skipped follower is grey, not red, and the release
check read the skip as "no mobile change".

**Enforcement:** `.github/workflows/deploy-prod-gate.yml`: the followers call it and run when `Deploy Prod`
succeeded or failed only in jobs whose name contains "Kortix Capture" or "desktop"; any
other failed job stops them. Its comment in `deploy-prod.yml` keeps those words in the job
names. After each release, check that both mobile workflows ran (`gh run list --workflow
mobile-ota.yml --limit 1`), not only that `Deploy Prod` finished.
