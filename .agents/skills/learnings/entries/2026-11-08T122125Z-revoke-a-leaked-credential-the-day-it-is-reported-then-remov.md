---
recorded: 2026-11-08T12:21:25Z
incident_date: 2026-04-14
---
# Revoke a leaked credential the day it is reported, then remove every place that still uses it

**Rule:** When a credential reaches a tracked file, a commit, or a public report, revoke it at the vendor the same day. Deleting the file does not help: the repo is public and the value stays in git history. Then, in the same change, remove every place that still reads it: CI workflows, AWS Secrets Manager keys, GitHub secrets, and local copies such as the macOS Keychain. Prefer a scoped token over an account-wide key, and never let CI use an account-wide key (for example a Cloudflare Global API Key).

**Trigger surface:** You triage a secret-scanning alert or a repository security advisory about a leaked key. Or you write a credential into any file, note, or status doc.

**Incident:**
- **2026-01-18:** an account-wide Cloudflare Global API Key with full account access was committed in an infra status markdown file.
- **2026-04-14:** an outside researcher reported it through a repository security advisory, which then sat in triage for about 7 months.
- **2026-08-18:** the key was revoked. Two workflows still read it: `configure-apps-edge.yml` used only that key and failed from 2026-08-28 on, and `deploy-staging.yml` probed it first.
- **2026-11-08:** the Keychain copy still held the revoked value. The GHSA sweep (PR #12082) confirmed Cloudflare rejects the value (error 9103), moved both workflows to scoped tokens, and closed the advisory.

**Enforcement:**
- gitleaks runs in CI on every push, and the pre-commit hook blocks plaintext secrets in `.env*` files.
- `tests/unit/no-cloudflare-global-key.test.ts` fails when a workflow or action reads `CLOUDFLARE_GLOBAL_API_KEY` or sends `X-Auth-Key`. None yet for a credential in prose markdown.
- None yet for advisories sitting in triage. The enforcer to build: a weekly job that lists repository advisories in `triage` that are older than 7 days.
