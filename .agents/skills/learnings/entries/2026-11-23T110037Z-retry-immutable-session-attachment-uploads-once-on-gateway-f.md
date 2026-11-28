---
recorded: 2026-11-23T11:00:37Z
incident_date: 2026-11-20
---
# Retry immutable session attachment uploads once on gateway failures

**Rule:** Retry a session attachment's immutable upload once on Storage HTTP 502/503/504. Keep upsert disabled and verify the existing bytes, size and MIME when the retry returns 409.

**Trigger surface:** Session-log blob uploads, large-text offload, attachment upload and fork copying.

**Incident:** On 2026-11-20 two session-log blob PUTs failed with StorageApiError Bad Gateway. The store propagated the first gateway response without attempting recovery.

**Enforcement:** `apps/api/src/projects/lib/session-attachments-transient.test.ts` drives the real Supabase client through gateway recovery, ambiguous commits, bounded retries and permanent refusals.
