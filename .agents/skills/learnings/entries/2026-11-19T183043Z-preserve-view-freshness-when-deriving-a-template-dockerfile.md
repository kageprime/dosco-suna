---
recorded: 2026-11-19T18:30:43Z
incident_date: 2026-11-19
---
# Preserve view freshness when deriving a template Dockerfile identity

**Rule:** Pass ordinary read freshness for template listings. Keep tip-proof freshness as the default for builds and destructive identity resolution.

**Trigger surface:** Listing sandbox templates or deriving a project Dockerfile identity for a page-view poll.

**Incident:** KRTX-4867 recurred after the route opted into stale mirror reads. `resolveUserDockerfile` forced a tip proof underneath that opt-in. Production slow requests recorded 1.6–3.4 seconds in Git; separate DB-heavy requests also remain.

**Enforcement:** `apps/api/src/snapshots/templates-view-freshness.test.ts` reads a populated template view from a real warm mirror with an unavailable upstream. The build path still refuses the unavailable upstream.
