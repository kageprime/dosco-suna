---
recorded: 2026-10-23T23:49:45Z
incident_date: 2026-10-24
---
# Invalidate the cache the provider actually reads

**Rule:** When a provider edge refuses a cached credential, invalidate the cache the provider's ingress resolver reads. Do not invalidate a proxy-level cache that the provider has disabled.

**Trigger surface:** Fixing a preview or App 401/403 after a sandbox pause-resume, or adding a credential-refresh retry to a proxy.

**Incident:** 2026-10-24, release v62. E2B previews and App iframes served the pre-resume traffic token. The first fix dropped the per-port preview link cache, but E2B sets `ingressCacheTtlMs = 0`; the stale token lived in the provider's 5 s connected handle. The retry re-resolved the same handle. Release v63 adds `SandboxProvider.invalidateIngress?`; the sandbox proxy and the App public proxy call it before their single retry.

**Enforcement:** `apps/api/src/platform/providers/e2b.test.ts` proves an immediate reconnect returns a new token after `invalidateIngress`. `apps/api/src/sandbox-proxy/routes/preview-characterization.test.ts` and `apps/api/src/apps/public-proxy-recovery.test.ts` prove both proxies invalidate before the retry.
