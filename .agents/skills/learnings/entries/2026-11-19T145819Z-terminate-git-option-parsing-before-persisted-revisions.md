---
recorded: 2026-11-19T14:58:19Z
incident_date: 2026-11-19
---
# Terminate git option parsing before persisted revisions

## Rule
Validate client branch settings before persistence. Put `--end-of-options` before revisions passed to `git log`; a trailing `--` protects paths, not earlier revisions.

## Trigger surface
A stored default branch or client revision becomes a git argument.

## Incident
PR #12728's security review found a pre-existing settings path that accepted an option-shaped default branch. A local reproduction overwrote a synthetic host file through `git log --output`.

## Enforcement
`project-detail-icon-patch.test.ts` rejects unsafe branch settings before a write. `mirror-view-stale.test.ts` proves a persisted option-shaped branch leaves a host file unchanged.
