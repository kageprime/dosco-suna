---
recorded: 2026-11-20T23:41:18Z
incident_date: 2026-11-20
---
# Keep a repository's data on a CI runner only when that runner takes that repository's jobs alone

**Rule:** A Vulcan feature that puts one repository's data on a runner VM
(a git mirror, a sticky Docker disk, a warm template's store or images)
must first make the runner take only that repository's jobs: the VM
registers in the repository's own runner group (`repoOnly()`,
`vulcan-repo-<name>`). An organization runner in the shared `vulcan`
group takes a queued job from any repository the group admits, so it can
run one repository's job on another repository's data.

**Trigger surface:** Adding or changing a Vulcan feature that copies
repository data into a VM at boot; reading a slow `actions/checkout` on a
`vulcan-*` runner; moving a private and a public repository into one
runner group.

**Incident:** 2026-11-20, found while measuring CI setup time. Over
2026-11-17 to 2026-11-20, 28.6 % of CompanyOS jobs on Vulcan (2,458 job
logs) ran on a VM booted for the private `kortix-ai/platinum` repository.
The VM held platinum's git warm cache (746–808 refs, ~260 MiB), so the
checkout fetched the whole tree from GitHub: fetch p50 48.7 s, p90 155 s,
max 1,371 s, against 1.8 s with CompanyOS's own cache. The jobs of the
public CompanyOS repository therefore had platinum's full branch history
on disk; only code those jobs ran could read it. 46 of 108 sampled
platinum jobs got CompanyOS's cache. Fixed in kortix-ai/vulcan#257: the
git warm cache is given only to a VM in the repository's own runner group,
the rule sticky disks already followed.

**Enforcement:** `test/git-mirror.test.ts` in kortix-ai/vulcan fails when a
VM outside its repository's runner group gets `VULCAN_GIT_MIRROR=1`. In a
CompanyOS job log, "Set up job" shows `Runner group name:
'vulcan-repo-CompanyOS'`, and every `Git warm cache:` line shows ~2,000
refs.
