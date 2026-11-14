---
recorded: 2026-11-14T00:12:49Z
incident_date: 2026-11-13
---
# Never read URLSearchParams.size in code the mobile app runs; test such a query under the app's polyfill

**Rule:** Build a query suffix with `querySuffix()` (`packages/sdk/src/core/http/url.ts`, which reads `params.toString()`), never from `params.size`. The mobile app installs `react-native-url-polyfill` (whatwg-url-without-unicode 8), whose `URLSearchParams` has no `size`: `params.size > 0` is false there and the whole query is dropped. A test of such a query runs under that polyfill, not only under Bun's native `URLSearchParams`.

**Trigger surface:** Adding or editing a query string in `packages/sdk` or any module the mobile app imports.

**Incident:** 2026-11-13, KRTX-4898. Since 2026-07-28 the SDK built session-list queries with `params.size`. On phones every drawer section and Sessions page chip read the same unfiltered list, so automated runs showed under the person's own sessions. KRTX-4705 (PR #12390) changed the filter, passed its Bun tests, and never took effect on a device. Seven other SDK calls (session start `wait_ms`, asks, tokens, costs, runtime log and messages) lost their queries the same way. KRTX-4900 (PR #12691) moved every site to `querySuffix()`.

**Enforcement:** `withSizelessURLSearchParams` (`packages/sdk/src/core/test-fixtures.ts`) tests in each SDK file that builds a query; `apps/mobile/lib/session/session-list-request.test.ts` sends every session-list request under the real polyfill.
