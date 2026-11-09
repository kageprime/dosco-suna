---
recorded: 2026-11-08T03:41:30Z
incident_date: 2026-11-08
supersedes: 2026-09-30T140728Z-classify-invalid-connector-graphql-as-a-caller-error-before.md
---
# Classify a provider-rejected caller input by its mechanism, never by tool scope or a closed code list

**Rule:** When a provider execution reports that the CALLER'S INPUT was rejected — the provider's own request validation (a 4xx status in the execute payload, a missing required argument) or the provider's argument-validation error text — answer it as a caller error (400, logged at debug), for every tool. Never scope such a classification to one toolkit or a closed list of error codes: the next shape leaks past it into the upstream-failure warn path and re-creates the spike. Keep 5xx, rate limits and HTML error pages on the upstream path.

**Trigger surface:** `executeComposio` (`apps/api/src/connectors/composio.ts`) and any provider-execution wrapper that maps failures to a status and a log level.

**Incident:** 2026-09-30's fix scoped caller-error classification to `linear.run_query_or_mutation` and two GraphQL codes. On 2026-11-07/08 prod warned 10–74 lines/h against a 0.13/h baseline with two unscoped shapes: Composio's own missing-required-argument 400 (70% of lines) and Linear `Code: INVALID_INPUT` rejections (16%) (KRTX-678 reoccurred).

**Enforcement:** `apps/api/src/connectors/composio.test.ts` — the three regression tests (missing-arg 400, `INVALID_INPUT`, any-toolkit payload 400) fail without the classification.
