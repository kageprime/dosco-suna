---
recorded: 2026-11-19T14:59:32Z
incident_date: 2026-11-16
---
# Retry a reset Storage connection once when signing a read-only attachment download URL

**Rule:** Retry signed-download URL creation once when Storage wraps an ECONNRESET. Do not replay writes or permanent HTTP refusals.

**Trigger surface:** Resolving a runtime prompt attachment through Supabase Storage.

**Incident:** On 2026-11-16, API 0.15.11 returned one attachment-descriptor 503 after a socket reset. The breadcrumb identified ECONNRESET; the request did not retry signing.

**Enforcement:** `apps/api/src/projects/prompt-attachments-transport.test.ts` proves recovery after one reset, a two-attempt bound, and no retry for missing objects or HTTP failures.
