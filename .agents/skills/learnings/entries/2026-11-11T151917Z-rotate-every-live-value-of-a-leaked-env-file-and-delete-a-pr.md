---
recorded: 2026-11-11T15:19:17Z
incident_date: 2026-11-11
---
# Rotate every live value of a leaked env file, and delete a provider key the moment nothing reads it

**Rule:** When an env file, a backup of one, or a doc with a credential reaches git, compare every value in it against the live Secrets Manager blobs by equality, without printing a value, and rotate each match. Rewriting history removes nothing that was already pushed. Delete a provider key from every blob and profile as soon as no running code reads it, so a leak has less to expose.

**Trigger surface:** A suspected key leak. A gitleaks finding in history. Retiring a vendor or an integration (an LLM provider, Pipedream, JustAVPS). Editing `kortix-<env>-env` in Secrets Manager.

**Incident:** 2026-11-11.
- A full-history gitleaks scan of 32,004 commits found 205 findings.
- A plaintext API env backup was committed in April 2026. A history rewrite later removed it from GitHub, but 9 of its values were still live 7 months later, among them the prod `INTERNAL_SERVICE_KEY` that authenticates billing cron routes and `/metrics`.
- A Cloudflare global API key sat in a doc on a public legacy branch and was still live in `kortix-ci-env`.
- The Armor log showed the prod API env decrypted by 5 members besides the owner, against the owner-only grant.
- Fixes:
  - #12430 rotated Tavily, Serper and Firecrawl in all envs.
  - #12433 deleted 21 retired provider, Pipedream and JustAVPS keys from prod (10–13 per non-prod blob), rotated the prod and preview internal key (prod `/metrics`: new key `200`, leaked key `401`), and deactivated 3 Bedrock IAM credentials.

**Enforcement:**
- `secret-scan` (gitleaks) and `scripts/check-env-encrypted.sh` catch new plaintext.
- None yet for history: run `gitleaks git --redact --log-opts=--all` after any vendor change, and build a nightly check that a historic gitleaks finding never equals a live Secrets Manager value.
