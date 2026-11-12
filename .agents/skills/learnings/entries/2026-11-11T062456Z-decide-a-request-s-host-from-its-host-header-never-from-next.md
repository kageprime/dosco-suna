---
recorded: 2026-11-11T06:24:56Z
incident_date: 2026-11-11
---
# Decide a request's host from its Host header, never from nextUrl: the standalone server builds nextUrl from its bind address

**Rule:** In `apps/web` middleware, read the request's host from `x-forwarded-host` or `Host`, never from `request.nextUrl`. A container health probe must hit `/api/health`, the one route every redirect exempts.

**Trigger surface:** Adding or changing a redirect, a host allowlist or a local-host exemption in `apps/web/src/middleware.ts`; changing a health check in `apps/cli/src/self-host/assets/kortix-compose.yml`.

**Incident:** 2026-11-11, v0.15.5. The HTTP→HTTPS 308 (#11707) exempted local hosts by `nextUrl.hostname`, which is `0.0.0.0` in the standalone server. The self-host compose probe of `http://localhost:3000/` got `308 → https://0.0.0.0:3000/` and failed on TLS. Every self-host update to v0.15.5 rolled the frontend back ("DEGRADED frontend=failed"); API and gateway updated. A customer self-host box ran a 0.15.5 API with the 0.15.1 frontend for ~2 h. Hosted Kortix was unaffected: its edge answers the 308. Fixed in #12394, shipped as v0.15.6.

**Enforcement:** `apps/web/src/middleware-https-redirect.test.ts` ("a container's own probe of localhost is never redirected, whatever its bind address") builds the request on `http://0.0.0.0:3000/` with a `Host` header. The release suite's "Self-host schema bootstrap" does not roll a frontend update; none yet for that: a self-host update smoke that rolls the new frontend image.
