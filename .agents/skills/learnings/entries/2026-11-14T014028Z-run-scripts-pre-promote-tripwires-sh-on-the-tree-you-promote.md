---
recorded: 2026-11-14T01:40:28Z
incident_date: 2026-11-13
supersedes: 2026-10-21T030710Z-run-the-release-suite-s-fast-tripwires-on-dev-head-before-ev.md
---
# Run scripts/pre-promote-tripwires.sh on the tree you promote; a red tripwire is fixed on dev before the dispatch

**Rule:** Before a Promote dispatch, run `bash scripts/pre-promote-tripwires.sh` on the `dev` SHA you promote (about 2.5 min, no server, no database). Each red check is fixed on `dev` first. A feature that adds a CLI command, an API route, a flow id or a managed-skill line also runs it before its own merge. What changed from the 2026-10-21 entry: the list is one script instead of prose, and it adds the cases v0.15.11 hit (`catch` database-error echo guard, route manifest, CLI commands doc, web audit route registry and route handlers, starter skill budgets, the root GHSA audit).

**Trigger surface:** dispatching `promote.yml`; merging a feature that joins a registry (MCP CLI decisions, audit route labels, `routes.generated.json`, flow ids, `generate-cli-commands-doc.mjs`).

**Incident:** v0.15.11 (release PR #12672, 2026-11-13) needed 3 release-suite runs. The first run failed in 5 lanes and 4 scanners on drift from same-day features (a duplicate flow id `CHN-35`, 3 CLI commands and 4 routes in no registry, i18n, a layer import, a skill budget, 2 advisories published that day). Fixes: #12675, #12679, #12684. The third run caught a real regression: #12660 left a promise rejection unhandled during session start. The release suite caught it.

**Enforcement:** `scripts/pre-promote-tripwires.sh` (the kortix-release skill, Step 2). It is manual: nothing yet makes `promote.yml` wait on it.
