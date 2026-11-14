# Source: security

Trigger `source-security` (cron, 02:00 UTC, one keyed session). Disabled by
default: a person enables it and names the targets. The **security factory**:
a continuous source that finds and proves vulnerabilities, files private
tickets, and hands each one to the normal pipeline. Its pull requests never
auto-merge.

## Hard rules (the safety envelope)

1. **Scope allowlist.** Attack only `sources.security.targets`. Default
   `["localhost"]`: the app this session starts from the trunk in its own
   sandbox. A deployed URL is in scope only when a person wrote it there and
   owns it. Never a host, tenant, account or deployment that is not on the
   list. A probe that needs an out-of-scope target is not run.
2. **Non-destructive and low-rate.** At most 30 requests per minute against a
   deployed target. No denial of service, no load, no brute force, no
   credential stuffing, no destructive writes, no data exfiltration. Stop each
   probe at the minimum evidence: one request and one response.
3. **Synthetic accounts only.** Tenant isolation is tested with two accounts
   this run creates on the local stack (account A reaches for account B's
   resource). A real user is never the victim. On a deployed target, only
   accounts a person created for the factory (`SECURITY_TEST_*` secrets).
4. **Customer data stops the probe.** A response that carries real personal
   data: stop that probe, store nothing, record only the class and the route.
5. **Proof required.** A finding needs a code anchor, a reachable input, the
   violated boundary, the expected and the actual result, and a reproduction
   that succeeds 2 of 2 times. A suspicion is not a finding.
6. **Sanitized and private.** Tickets hold the class, the route, the severity,
   redacted steps and the fix. Never a working exploit, a token or a secret.
   On a public repository with a public store, file into a private store
   (`json-file` on a private repository, or a private tracker) and open a draft
   GitHub security advisory (`gh api repos/<repo>/security-advisories`); never
   a public issue.
7. **Producer only, never auto-merged.** This source writes tickets and the
   `security:ledger` only. The fix runs through intake, a worker and the merge
   gate, which always holds a `source:security` pull request for a person.

| | |
|---|---|
| Signal | one attack class against one surface, least recently covered first |
| Finding | a confirmed vulnerability, or a concrete hardening change with evidence (a missing security header, a cookie without `HttpOnly`, a permissive CORS rule) |
| Bar | rule 5 |
| Key | `security:<cwe id or class>:<anchor slug>` (anchor = file and function, or method and route) |
| Signal value | `signal: severity=<1-4> reproduced=2/2` |
| Priority | 1 critical or high; 2 medium; 3 low or hardening |
| Kind | `security` |
| Credentials | `FACTORY_GITHUB_TOKEN` read; the dev environment secrets; `SECURITY_TEST_*` for a deployed target |

## Attack classes

| Class | Check |
|---|---|
| `authn` | protected routes with no token, an expired token, a token with `alg: none`, a tampered signature; session fixation; password reset token reuse |
| `authz-idor` | account A reads or writes account B's record by changing an id, on every route that takes an id |
| `authz-role` | a member calls an admin-only route |
| `injection` | SQL, NoSQL, command, template and header injection in every input; XSS in every rendered field |
| `ssrf` | the server fetches an internal or attacker-controlled URL (`http://169.254.169.254/`, `http://localhost:<port>/`) |
| `secrets` | secrets in responses, error pages, source maps, client bundles, the git history (`gitleaks detect` or `trufflehog git file://.`) |
| `files` | path traversal in uploads and downloads, content-type confusion, unrestricted size |
| `config` | CORS, CSP, cookie flags, TLS, debug endpoints, default credentials |
| `deps` | a vulnerable dependency reachable from a running path (`dependencies.md` covers the audit) |
| `static` | `semgrep --config auto --json` (when installed) findings that a manual read confirms |

## Run

1. Read the `security:ledger` ticket (create it on the first run): a coverage
   table `class | surface | last run | sha | verdict`.
2. Clone the trunk, start the app per the `dev-environment` skill, record the
   base URL. Map the surface: routes (the router files), forms, uploads, auth
   flows, outbound calls.
3. Pick at most 3 classes, least recently covered first. Run each against the
   local app; against a deployed target only within rule 2.
4. Reproduce every candidate twice. Not 2 of 2: drop it, note `inconclusive`
   in the ledger.
5. Upsert one ticket per confirmed finding (contract §5): semantic lookup by
   class and surface first. `## Acceptance`: a regression test that fails
   before and passes after; the denied path and the allowed path both shown on
   the local stack.
6. Rescan: for every `security:*` ticket that is `done`, re-run its class at the
   current commit. Reproduces: `[factory-source] reoccurred`.
7. Rewrite the ledger table; one `[factory-source] update · run` comment with
   classes run, verdicts and keys.
8. End with `source-security:`, the contract run line, `classes=<n>
   confirmed=<n> scope_ok=<yes|no> rate_ok=<yes|no>`.
