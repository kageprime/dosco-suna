---
recorded: 2026-10-26T16:40:36Z
incident_date: 2026-10-26
---
# Keep E2B snapshot adapter registered when E2B is an allowed provider

**Rule:** Whenever `ALLOWED_SANDBOX_PROVIDERS` includes a provider (`e2b`), register its `SandboxProviderAdapter` in `apps/api/src/snapshots/providers/index.ts` `ADAPTERS`, include it in `SANDBOX_TEMPLATE_PROVIDERS`, and implement its `isProviderEnabled` branch in `config.ts`. Never unregister a provider from snapshot image resolution while deployments serve it.

**Trigger surface:** Modifying sandbox provider configuration, snapshot adapters, or retiring provider support across `apps/api/src/snapshots/providers/` and `apps/api/src/config.ts`.

**Incident:** 2026-10-26, PR #10310 (commit `08a64413b3`) removed E2B support from snapshot adapters and provider coverage to make Platinum the reference provider. When deployed to a live deployment configured with `ALLOWED_SANDBOX_PROVIDERS=e2b`, every session startup failed immediately with `Unknown sandbox provider: e2b`, surfacing the generic error *"The sandbox provider could not start this session. Try again."*.

**Enforcement:** `apps/api/src/snapshots/provider-coverage.test.ts` (parity guard asserting `SANDBOX_TEMPLATE_PROVIDERS` registration) and `apps/api/src/platform/providers/e2b.test.ts`.
