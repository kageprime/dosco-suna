---
recorded: 2026-10-30T22:23:11Z
incident_date: 2026-10-30
---
# Bound in-flight ttlMemo loads so a hung socket never wedges a key

**Rule:** Bound every in-flight `loader` and stale-while-revalidate `refresh` in `ttlMemo` (`apps/api/src/shared/ttl-memo.ts`) with `inflightTimeoutMs` (default `15_000` ms, under the 25 s `requestDeadline`), and evict the cache entry on timeout. Never share an unsettled in-flight promise (`!hit.settled` or `hit.refreshing`) without an expiration deadline.

**Trigger surface:** Editing `apps/api/src/shared/ttl-memo.ts` or adding in-flight promise deduplication on request-path caches (IAM principal resolution, role catalogs, or provider health polls).

**Incident:** 2026-10-30, live API outage on `api.dosco.live` (`web.1`). An earlier database query inside `resolvePrincipalMemo` (`apps/api/src/iam/actor.ts`) hung on a half-open socket and never settled. Because `ttlMemo` checked `if (hit.expiresAt > Date.now() || !hit.settled) return hit.value`, `hit.settled` stayed `false` indefinitely and every subsequent authenticated request for `<user_id>|<account_id>` awaited that dead promise until the 25 s `requestDeadline` returned `503` (`Server-Timing: auth;dur=140;desc="n=1", iam;dur=24714;desc="n=1", db;dur=290;desc="n=2"`), while public DB routes and background workers continued to succeed in ~290 ms.

**Enforcement:** `apps/api/src/__tests__/unit-ttl-memo.test.ts` (`evicts a hung in-flight load after inflightTimeoutMs so later calls recover` and `unblocks a hung background refresh after inflightTimeoutMs so the next call retries`).
