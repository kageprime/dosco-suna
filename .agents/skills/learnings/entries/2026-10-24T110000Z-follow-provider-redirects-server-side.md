---
recorded: 2026-10-24T11:00:00Z
incident_date: 2026-10-24
---
# Follow provider-hosted redirects server-side; never bounce the browser through an upstream host

**Rule:** An upstream that canonicalizes onto its provider's own host family must be followed by the proxy, bounded, and never handed to the browser; and a redirect must never be rewritten onto the public host, because an app that canonicalizes every path will bounce against the rewrite forever.

**Trigger surface:** Modifying preview or App proxy redirect handling (`sanitizeRedirectLocation`, the 3xx branch of the preview retry loop, or the App `respondFromUpstream`), or choosing where a proxied redirect chain resolves.

**Incident:** 2026-10-24, release v65. Two failure modes met at the same seam. A browser given a `.e2b.app` Location loses the traffic-access-token header on the follow-up and faces the provider's 403 page. The first patch rewrote the Location to the public App host instead — which loops against any app whose middleware bounces every path (including the rewritten one) back onto the upstream host: rewrite and app answer each other forever and the browser reports `ERR_TOO_MANY_REDIRECTS`. Release v67 replaces the rewrite with `followProviderIngressRedirects`: GET/HEAD only, max 3 hops, only hosts under the configured E2B cluster domain, credentials re-attached on every hop, a write redirect passed through untouched, and a fruitless chain answered with a visible `502 sandbox_redirect_loop`.

**Enforcement:** `apps/api/src/apps/public-proxy.test.ts` proves the App proxy follows a provider-host chain, refuses external/relative targets and writes, and caps an alternating-host storm at 3 hops; `apps/api/src/sandbox-proxy/routes/preview-characterization.test.ts` proves the preview proxy follows the hop server-side (no Location reaches the browser), answers the storm with the loop 502, and never follows a write.
