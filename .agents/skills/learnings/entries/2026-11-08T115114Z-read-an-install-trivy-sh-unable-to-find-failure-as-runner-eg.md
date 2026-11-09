---
recorded: 2026-11-08T11:51:14Z
incident_date: 2026-11-08
---
# Read an install-trivy.sh 'unable to find' failure as runner egress to github.com, and probe the releases endpoint with a printed HTTP status before the upstream installer

**Rule:** When `Scan + SBOM + sign API image` fails with `aquasecurity/trivy
crit unable to find 'v<semver>'` after the `checking GitHub for tag` line hung
minutes, the tag exists upstream and the runner cannot reach
`github.com`. Treat it as runner egress, retry the deploy later, and never
read it as a missing tag or a script bug. `infra/scripts/install-trivy.sh`
now probes `https://github.com/aquasecurity/trivy/releases/<tag>` first with
`--connect-timeout 10 --max-time 30`, prints the HTTP status, retries 3
times, and fails with "runner egress to github.com is down, NOT a missing
tag" — read that line as the egress signal. The same egress timeout also
surfaces in `terraform init` as `failed to retrieve authentication
checksums ... context deadline exceeded` on a provider release download;
both jobs failing together in one `Deploy Dev` run means the runner's
`github.com` egress is down, and every later deploy stays blocked until a
retry dispatch runs green. Do not fail the jobs over to GitHub-hosted
runners: they are billed minutes on a private repository (rule 2026-11-03).

**Incident:** 2026-11-08, 09:18-11:28 UTC. Every `Deploy Dev` run failed the
same two jobs: the Trivy install (the "unable to find" lie after a 2-minute
hang) and `terraform init` (`context deadline exceeded` retrieving the
Cloudflare provider checksums from github.com). Dev froze at the 10:16
build while three merges stranded. The runs' own logs could not say
"timeout": the pinned upstream installer swallows the HTTP status.

**Enforcement:** `tests/unit/install-trivy.test.ts` drives the real pinned
installer through a curl stub: a timeout must fail bounded (3 attempts,
`--max-time` on each) with the HTTP status printed and never the
"unable to find" lie; a 404 must print the status; a 200 must proceed to
the pinned-installer checksum; a stalled body (200 written out, curl exit
28/18) must fail the probe — success requires curl exit 0 AND HTTP 200.

**Resolution:** 2026-11-08, 12:18 UTC. Retry dispatch run 42479630567 went
green with both Terraform roots applied: the releases query answered in
0.6 s, Trivy installed in 2.7 s, and `cloudflare/cloudflare v4.52.10`
downloaded (checksum retrieval included) in 0.69 s — all far inside the
30 s bound. The egress outage self-recovered; the three stranded merges
deployed, and dev serves the newest one. The probe stays as the permanent
diagnostic for the next outage.
