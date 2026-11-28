---
recorded: 2026-11-24T19:30:40Z
incident_date: 2026-11-24
---
# A client reads a session's log only through GET …/log; the API decides between the running box and the stored log and says which in source

**Rule:** A web, desktop, mobile or SDK client reads a session's log only through `GET /v1/workspaces/:p/sessions/:s/log`. It never reads the box's `GET /kortix/runtime/log` itself. For the newest page it sends `live=1`: the API reads the running box with a 2 s budget (`apps/api/src/projects/session-log-live.ts`) and answers `source: 'box'`, or its stored log with `source: 'store'` when the box is not running, does not answer in time, answers another thread or an older generation. Only a `source: 'box'` page answers for the thread's tail in `applySessionLogPage`; a page without `source` is the stored log.

**Trigger surface:** Changing how `useSessionLogSync` (`packages/sdk/src/react/use-session-log.ts`) reads pages; adding a page reader in a host or the SDK; changing `GET …/log` or its `live` path; changing the settle rule for `source` in `applySessionLogPage`. Related: `2026-11-24T144139Z-a-session-log-page-settles-only-up-to-its-own-last-seq-becau.md` (a stored page settles only up to its own last seq).

**Incident:** 2026-11-24 (KRTX-5139, prod v0.16.4): the web read two sources and merged them on the client. After a failed box read it fell back to the stored log, which lagged the box by minutes while journal posts backed off on API `5xx`, and the merge removed the newest assistant replies until a hard refresh. #13040 fixed the merge rule; this change removes the client's choice of source, its 10-minute box skip, and its 50 s proxy wait on a wedged box.

**Enforcement:** `packages/sdk/src/react/use-session-log-host.test.ts` (the open reads `…/log?limit=40&live=1` and nothing under `/kortix/runtime/log`); `packages/sdk/src/react/use-session-log.test.ts` ("one read endpoint" block: a box page settles the tail, a stored page answering a live read keeps newer replies, a page with no source is the stored log); `apps/api/src/__tests__/integration-session-log-read.test.ts` ("GET .../log?live=1" block: box answer, 2 s budget, other thread, older generation, stopped box, `before_seq`, a new session, the read gate first).
