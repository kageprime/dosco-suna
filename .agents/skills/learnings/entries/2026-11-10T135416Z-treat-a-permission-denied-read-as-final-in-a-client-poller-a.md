---
recorded: 2026-11-10T13:54:16Z
incident_date: 2026-11-10
---
# Treat a permission-denied read as final in a client poller: a role denial never heals by refetching

**Rule:** When a read denies with 403 because the caller's role lacks the action, the answer is final for that credential: no refetch changes the role. A client that polls an errored query (a fail-safe refetch interval, a retry loop, a converge poll) must stand down on the permission denial — classify it beside the final 404/410 stand-down — and let a mount, an invalidation or a credential change be the heal path. Reserve polling for errors a retry can change (5xx, network blips).

**Trigger surface:** any React Query `refetchInterval` fail-safe, retry loop or converge poll over an SDK read gated on a role-tier action (e.g. `project.secret.read`, manager-tier); `packages/sdk/src/react/query-contracts.ts` `contract()` consumers whose observer never unmounts (a project-shell hook).

**Incident:** 2026-11-10, prod API v0.15.3. A member whose role lacks `workspace.secret.read` kept a dashboard open: `useGatewayCatalogSync` mounted the manager-tier secrets read for the whole shell, and the contract's error fail-safe re-asked the typed 403 every 30.1 s (the backoff cap) for as long as the tab lived — 42 identical warn lines in 20 minutes, 17.6x the route's baseline, two days in a row. The sweep filed it as a prod log anomaly; the denial itself was the gate working.

**Enforcement:** `packages/sdk/src/react/use-gateway-catalog-sync.test.ts` drives the real TanStack engine with a wired 403 and asserts exactly one fetch on a mounted page, while a 500 keeps the fail-safe. New pollers need the same shape: wire-level fetch count under fake timers, one ask for a final denial, growth for a transient error.
