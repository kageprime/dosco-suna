---
recorded: 2026-11-09T16:12:57Z
incident_date: 2026-11-09
---
# Carry a prod-error fix to staging in the same session, and read model tool input by type

**Rule:** A fix for an error reported from prod is not done when it merges to `dev`. In the same session, check `git merge-base --is-ancestor <fix> origin/prod`. If the fix is only on `dev`, open a `stage-fix/*` pull request into `staging` with the cherry-picked commits, and dispatch `gh workflow run tests.yml --ref <that branch>`, because a pull request into `staging` runs no CI. In UI code, read every field of model tool input by type: a model can send every optional field, so `input.a || input.b` falls from `""` to the next field, and that field's schema can be an object.

**Trigger surface:** Fixing a prod frontend error (Better Stack, a user report, a minified stack trace); reading `partInput(call)` fields in a tool row; planning how a fix reaches prod while a release pull request is open.

**Incident:** 2026-11-09, KRTX-4511. Prod v0.15.1 crashed the session page with `TypeError: e.replace is not a function`. The pi `agent` tool defines `agent` as an object (an inline agent spec). The reported session (`codex/gpt-6.1-sol`) sent `subagent_type: ""` and `name: ""` beside it in 3 of 7 calls, so the task row passed the object to `agentDisplayName`. #12088 fixed it on `dev` on 2026-11-08, but nothing carried it to `staging`, so prod kept crashing until #12128 went to `staging` and v0.15.2 was re-promoted and shipped (release PR #11994, merge `424840ed3f`, deploy-prod run 42645930076).

**Enforcement:** `packages/ui/src/session/tool/tools/task-tool.test.tsx` renders the exact prod input shape and requires the "Inline" label. Nothing flags a prod-error fix that reaches `dev` but never `staging`; a check on fix PRs that cite a prod error is the TODO.
