---
recorded: 2026-10-24T11:24:49Z
incident_date: 2026-10-24
---
# Derive provider host ownership from the dialled ingress host, never from the API domain config

**Rule:** To decide whether a URL belongs to the sandbox provider, compare it with the parent domain of the ingress host the proxy just dialled. Never compare it only with `E2B_DOMAIN`: on E2B Cloud that variable is the API domain (`e2b.dev`), and sandbox ingress is served on a different domain (`e2b.app`). Pin the production value of a config variable in the test, not a value that makes the test pass.

**Trigger surface:** Writing or reviewing any host allowlist for provider traffic: the redirect follower (`providerIngressTarget`), redirect sanitizing, CSP or CORS host lists, or any code that reads `e2bDomain()` to name a sandbox host.

**Incident:** 2026-10-24, releases v67/v68. The server-side redirect follower trusted only hosts under `.${E2B_DOMAIN}` (`.e2b.dev`). Because E2B's JS SDK derives `getHost()` from `domain`, `baseUrl` was also `*.e2b.dev`. E2B Cloud's edge 308-redirects every browser navigation on `*.e2b.dev` onto `*.e2b.app`. On v68, parent domain extraction on `baseUrl` yielded `e2b.dev`, which still failed to match the `*.e2b.app` Location, leaking the 308 to the browser without the traffic token header and displaying "Missing traffic access token". Release v69 set `E2B_DOMAIN=e2b.app` on Heroku, and release v70 defaulted `E2B_DOMAIN` to `e2b.app` and united E2B Cloud's domain family (`e2b.app`, `e2b.dev`, `e2b.pro`) in `providerIngressTarget` while keeping self-hosted clusters isolated.

**Enforcement:** `apps/api/src/sandbox-proxy/provider-redirect-follow.test.ts` pins `E2B_DOMAIN=e2b.dev` and proves an `.e2b.app` hop is followed, an external or look-alike host (`e2b.app.example.com`) is not, and a one-label parent is not trusted.
