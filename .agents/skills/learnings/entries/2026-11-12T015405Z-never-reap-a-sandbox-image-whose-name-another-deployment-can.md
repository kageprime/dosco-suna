---
recorded: 2026-11-12T01:54:05Z
incident_date: 2026-11-11
---
# Never reap a sandbox image whose name another deployment can compute

**Rule:** Delete a provider image only when its name is scoped to this deployment (a project id, an environment). A name that another deployment on the same provider org computes for its own use (`kortix-default-<hash>`, which carries no environment) is never reaped by a predecessor sweep: the local database cannot see the other deployment's rows.

**Trigger surface:** You add or change an image reaper, quota GC, or a `deleteSnapshot` call (`apps/api/src/snapshots/`), or point two environments at one provider org or key.

**Incident:** 2026-11-11, release v0.15.8 (gate run 43123646411). Dev and staging share one Platinum org. A dev deploy moved its default image and its predecessor reaper deleted `kortix-default-c9bd85a7e4c0` at 23:58 UTC, the image the staging API at the frozen candidate computed as its default. The release gate's `deployed api smoke` waited 15 min for the image and failed twice. Fix: #12506 (`dev`), #12508 (`staging`): `kortix-default-` leaves `REAPABLE_TEMPLATE_PREDECESSOR_PREFIXES`; the staging worker rebuilt the image on its next start.

**Enforcement:** `apps/api/src/snapshots/predecessor-reap-policy.test.ts` ("never deletes a platform default"), `packages` lane. None yet for the structural fix: an environment-qualified default image name, as `kortix-mykortix-<env>-` already has.
