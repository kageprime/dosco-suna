---
recorded: 2026-10-20T11:53:26Z
incident_date: 2026-10-20
---
# Bound every provider SDK await a request path can inherit

**Rule:** Every provider SDK promise a request path can await gets a budget. Deduplication maps that serve a pending SDK promise to later callers must also self-clear on timeout, so the next caller re-dials instead of inheriting the corpse.

**Trigger surface:** Writing provider integration code (`platform/providers/*`), a proxy route that dials a sandbox provider, or any shared map keyed by an external id that stores a pending promise.

**Incident:** 2026-10-20, Heroku release v30 image with the API the day of the session-open incident. One hung `Sandbox.connect` (its SDK deadline was ~1 h) was stored in the in-process connect map; every later caller — `/start` and the SSE `/events` — inherited that same pending promise and hit Heroku's 30 s router cap (H12) until a dyno restart, while box-free routes answered in ~1 s. Probes proved the box, daemon, E2B proxy, and traffic token healthy: the SDK call was the only hung hop. Fix deployed same day (`e2b.ts`: request-path connect budget, bounded wake-cooperation, whole-wake budget), sessions start cleanly on the next release.

**Enforcement:** `e2b.ts` constants (`KORTIX_E2B_*`). A unit test still to be added: a `Sandbox.connect` fake that never settles must make `connected()` and `resolveIngress()` reject within the request budget, not block — none yet: enforcer to build in `e2b.test.ts`.
