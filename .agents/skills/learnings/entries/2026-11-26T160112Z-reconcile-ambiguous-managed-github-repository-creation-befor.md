---
recorded: 2026-11-26T16:01:12Z
incident_date: 2026-11-04
---
# Reconcile ambiguous managed GitHub repository creation before retrying

**Rule:** After a managed create returns 502/503/504, read the exact owner/name before replaying. Recover only a fresh, empty repository with matching visibility. Fail closed on a failed read or unrelated repository.

**Trigger surface:** Creating an empty managed GitHub repository during project provisioning.

**Incident:** 2026-11-04, v0.14.19: SHIP-1 failed on one GitHub 502 while 40 other release flows passed.

**Enforcement:** `apps/api/src/projects/github-create-retry.test.ts` covers bounded attempts, ambiguous success, collisions, fail-closed reconciliation and unaffected callers.
