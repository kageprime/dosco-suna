# Source: dependencies

Trigger `source-dependencies` (cron, Wednesdays 04:00 UTC). Disabled by
default. Read-only.

| | |
|---|---|
| Signal | the lockfiles of the trunk |
| Finding | a known vulnerability in a dependency that a running path can reach; a runtime or framework past its end of life; a major version the repository's own code already warns about |
| Bar | a vulnerability of severity high or critical, or medium with a reachable call (the vulnerable function or module is imported by production code, `git grep`); a fixed version exists; the upgrade is not already open as a pull request (Dependabot or Renovate). End of life: the vendor's published date is past or within 90 days |
| Key | `deps:<ecosystem>:<package>:<advisory id lowercased, or eol-<version>>` |
| Signal value | `signal: severity=<1-4> reachable=<0\|1> dependents=<n>` |
| Priority | 1 critical and reachable; 2 high and reachable; 3 medium or end of life; 4 others |
| Kind | `dependency` (`security` when it is a vulnerability) |
| Credentials | `FACTORY_GITHUB_TOKEN` (read Dependabot alerts with `security_events` read when the token has it) |

## Run

1. Clone the trunk. Find the lockfiles: `pnpm-lock.yaml`, `package-lock.json`,
   `yarn.lock`, `bun.lock`, `poetry.lock`, `uv.lock`, `requirements*.txt`,
   `go.sum`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`.
2. Audit each with the ecosystem's tool, JSON output into a file:
   `pnpm audit --json`, `npm audit --json`, `pip-audit -f json`,
   `govulncheck -json ./...` (reachability built in), `cargo audit --json`,
   `bundle audit check --format json`; or one tool for all: `osv-scanner
   --format json -r .`. Also `gh api repos/<repo>/dependabot/alerts?state=open`
   when allowed.
3. Reachability: for each advisory, `git grep` the imports of the package (and
   the vulnerable function when the advisory names it) in production paths,
   not tests.
4. Skip an advisory that an open pull request already upgrades
   (`gh pr list --search "<package> in:title" --state open`).
5. Upsert one ticket per package (fold all advisories of one package; the
   highest decides the key and priority). `## Proposed change`: the smallest
   upgrade that fixes every advisory (patch or minor first), the lockfile
   command, the changelog's breaking notes. `## Acceptance`: the audit command
   reports the advisory gone; the test suite of each touched package passes.
6. A public repository: never write exploit detail; the advisory id is enough.
7. End with `source-dependencies:`, the contract run line, `advisories=<n>
   reachable=<n>`.
