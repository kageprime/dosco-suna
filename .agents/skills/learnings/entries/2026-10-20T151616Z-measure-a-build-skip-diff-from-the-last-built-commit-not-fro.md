---
recorded: 2026-10-20T15:16:16Z
incident_date: 2026-10-20
---
# Measure a build-skip diff from the last built commit, not from HEAD^

**Rule:** A build-skip decision must diff the pushed tip against the commit the
previous build shipped (Vercel: `VERCEL_GIT_PREVIOUS_SHA`), never against the
local parent (`HEAD^`). Vercel/CIs build only the pushed tip, so a push that
bundles a frontend commit with a non-frontend tail measures tail-only against
`HEAD^` and cancels the one build the push gets — the frontend work in the
middle never deploys on its own.

**Trigger surface:** any monorepo whose ignored-build-step or CI build gate
decides "skip" from changed paths; multi-commit pushes; the guard that shields
a deploy target from non-frontend pushes.

**Incident:** 2026-10-20, main carried a hero/footer redesign commit plus a
ledger-only tail. The Vercel build for the pushed tip diffed against `HEAD^`
(ledger markdown only), printed "only non-FE paths", exited 0, and canceled
the build seconds after creation. The redesign commit had no deployment of
its own, so production kept serving the previous design. The script fix now
resolves the diff base through `VERCEL_GIT_PREVIOUS_SHA` with a `HEAD^`
fallback and echoes the base it measured; the next build's log proved it:
"diff base = previous deployed commit b2f5d3dba7", matching the last shipped
frontend commit. The redesign's follow-up build then failed for an unrelated
OOM, recorded separately.

**Enforcement:** none yet: a CI check that replays a pushed tip's skip
decision against the branch's tracked deployment status, failing loudly when a
skip would leave unshipped frontend work. The script's echoed "diff base"
line is the audit trail until then.
