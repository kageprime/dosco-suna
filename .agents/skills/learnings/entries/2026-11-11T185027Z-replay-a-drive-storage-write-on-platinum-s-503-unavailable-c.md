---
recorded: 2026-11-11T18:50:27Z
incident_date: 2026-11-10
---
# Replay a Drive storage write on Platinum's 503 unavailable contract: the body names the call it never ran

**Rule:** Replay a Drive storage call on an upstream `503` whose body carries `code:"unavailable"`, GET or write, at most twice after 2 s and 3 s, releasing the failed body first and stopping when the caller aborts. The code names a call the storage never ran — its own error body says to send it again. Every other write 503 stays single-attempt: an opaque failure may have committed (the 2026-10-28 rule stands for it).

**Trigger surface:** `apps/api/src/drives/volumes.ts`, the shared Platinum volume adapter used by Files, session mounts and background Drive workers.

**Incident:** KRTX-4745, 2026-11-10 16:54 UTC: during a Platinum storage control-plane degradation (hundreds of volume reads timing out at their caller budgets over ~4 h), one Files upload (`PUT /v1/drives/:id/files/content`) answered `503 {"error":"database connection reset, retry","code":"unavailable"}` and surfaced as the only user-visible typed 503 of the window (Better Stack 1 occurrence, 1 user). Reads retried since KRTX-3607; writes skipped the retry and let a self-describing transient reach the person.

**Enforcement:** `apps/api/src/drives/volumes-retry.test.ts` — a write on the `unavailable` contract replays and lands, a persistent one stays a typed error after two retries, aborting during the backoff stops the next request, and a write 503 without the contract still never replays.
