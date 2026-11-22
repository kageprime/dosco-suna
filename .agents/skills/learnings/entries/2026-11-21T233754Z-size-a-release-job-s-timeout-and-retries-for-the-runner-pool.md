---
recorded: 2026-11-21T23:37:54Z
incident_date: 2026-11-21
---
# Size a release job's timeout and retries for the runner pool it runs on

**Rule:** When a `CI_RUNNER_*` variable moves a tier to another runner pool, re-time the release
jobs on that pool. Give each one a timeout of at least twice its slowest recent run. Retry
every call to a rate-limited registry (Docker Hub). A release job that fails after prod is live
leaves a release half published.

**Trigger surface:** Changing a `CI_RUNNER_*` repository variable. Adding or editing a job in
`deploy-prod.yml` that runs after `verify-live-version` (`github-release`,
`promote-prod-channel`). Setting a `timeout-minutes`.

**Incident:** Every `CI_RUNNER_*` variable names a Vulcan runner (last set 2026-11-18). On those runners the
`github-release` job's "Download CLI artifacts" step (386 MB) took 11.6, 10.8 and 14.7 min
for v0.16.1 to v0.16.3. The job's timeout was 15 min. On 2026-11-21 v0.16.3's job hit it
during "Install cosign" and was cancelled. In the same run, `promote-prod-channel` got
`429 Too Many Requests` from Docker Hub on a logged-in blob HEAD request, after it had
re-tagged api and gateway. Prod served 0.16.3, but no GitHub Release v0.16.3 existed. The
public changelog had no entry, the announcement was skipped, and `:prod`/`:latest` were mixed:
api and gateway on 0.16.3, frontend on 0.16.2. A grey cancelled job does not
read as a failure, and the gap was found only when the next release was prepared.

**Enforcement:** #12991: `github-release` has `timeout-minutes: 30`, and the `:prod`/`:latest` re-tag
retries each image 4 times, 30/60/120 s apart. After each release, check the GitHub Release
and that `:prod` has the digest of `:X.Y.Z` for api, gateway and frontend, not only
`/health` (the **kortix-release** skill, Step 9).
