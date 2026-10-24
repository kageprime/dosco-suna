---
recorded: 2026-10-24T11:24:49Z
incident_date: 2026-10-24
---
# Derive provider host ownership from the dialled ingress host, never from the API domain config

**Rule:** To decide whether a URL belongs to the sandbox provider, compare it with the parent domain of the ingress host the proxy just dialled. Never compare it only with `E2B_DOMAIN`: on E2B Cloud that variable is the API domain (`e2b.dev`), and sandbox ingress is served on a different domain (`e2b.app`). Pin the production value of a config variable in the test, not a value that makes the test pass.

**Trigger surface:** Writing or reviewing any host allowlist for provider traffic: the redirect follower (`providerIngressTarget`), redirect sanitizing, CSP or CORS host lists, or any code that reads `e2bDomain()` to name a sandbox host.

**Incident:** 2026-10-24, release v67 (live about 15 min). The server-side redirect follower followed only hosts under `.${E2B_DOMAIN}` = `.e2b.dev`. Every E2B Cloud canonical-host hop (`<port>-<sandbox_id>.e2b.app` → `<sandbox_id>.e2b.app`) failed the check and reached the browser as a 308. The browser followed it to the E2B edge without the traffic token header and got the "Missing traffic access token" page on every redirecting preview. v65 had masked the gap with a hard-coded `.e2b.app`. The v67 test set `E2B_DOMAIN=e2b.app`, so it passed. Release v68 trusts the dialled host's parent domain (a one-label parent is never trusted) plus `E2B_DOMAIN`.

**Enforcement:** `apps/api/src/sandbox-proxy/provider-redirect-follow.test.ts` pins `E2B_DOMAIN=e2b.dev` and proves an `.e2b.app` hop is followed, an external or look-alike host (`e2b.app.example.com`) is not, and a one-label parent is not trusted.
