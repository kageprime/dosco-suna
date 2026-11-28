---
recorded: 2026-11-25T23:19:32Z
incident_date: 2026-11-25
---
# Verify a streamed API response through the real edge, with Accept-Encoding and X-Forwarded-For, before calling it streamed

**Rule:** A route that streams a body slowly sets `Cache-Control: no-transform` with `c.header()` (never only on a `Response` it builds) and returns `c.body(stream)`; prove it with `curl -N --trace-time` against the deployed host, or locally with `-H 'Accept-Encoding: gzip' -H 'X-Forwarded-For: 203.0.113.7, 10.0.0.1'`, and see the first byte arrive within 1 s.

**Trigger surface:** Adding or changing an API route whose body arrives over time (keep-alive bytes, a long-running answer, any stream that is not `text/event-stream`).

**Incident:** 2026-11-25, the QualiLoop test endpoint (#13078). Its 15 s keep-alive spaces never left the origin, so every turn over 100 s got a Cloudflare `524` (QualiLoop Core run 14). A local curl without those headers streamed fine, which hid three layers: the turn ran inside the stream's async `start()` (#13091); `compressResponse` peeked 1 KB of the JSON body and held it until the answer, only when `Accept-Encoding` was sent (#13095: it now skips `no-transform`); and the public edge rate limit, active only with `X-Forwarded-For`, set `Cache-Control: no-store` before the route, which Hono copied over the route's own `Response` headers (#13096). Dev traces: everything at once with a `content-length`; after the fixes, the first byte at +0.16 s.

**Enforcement:** `bun test apps/api/src/middleware/compress.test.ts` ("Cache-Control: no-transform is refused"). The edge rate limit still overwrites `Cache-Control` on a self-built `Response`: none yet, the enforcer is a route test that sends `X-Forwarded-For` and asserts the route's own `Cache-Control`.
