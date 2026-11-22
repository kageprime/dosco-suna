---
recorded: 2026-11-20T09:46:05Z
incident_date: 2026-11-20
---
# Add workspace twin foreign keys when adding a project reference

**Rule:** During workspace R2a, every new FK into projects needs a deferred
NO ACTION twin into workspaces. Add it NOT VALID; preserve the old cascade.

**Trigger surface:** A migration adds a project-scoped table during the cutover.

**Incident:** KRTX-5039: the nightly core-db lane found trigger admissions
missing its workspace twin. Other failing lanes had independent causes.

**Enforcement:** `workspaces-twin-foreign-keys.integration.test.ts` compares the
real migrated catalog and explicitly requires the admissions reference.
