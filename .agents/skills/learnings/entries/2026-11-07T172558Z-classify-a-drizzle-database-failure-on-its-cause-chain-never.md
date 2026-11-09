---
recorded: 2026-11-07T17:25:58Z
incident_date: 2026-11-07
---
# Classify a drizzle database failure on its cause chain, never on error.message

**Rule:** A catch that must tell database failures apart reads the whole cause chain (`isUniqueViolation`, `isDatabaseError`) or the pg SQLSTATE — never `error.message`. Every drizzle statement failure arrives as a `DrizzleQueryError` whose `message` is only `Failed query: <statement>\nparams: <params>`; the pg detail and SQLSTATE hang off `cause`. `apps/api/src/billing/wallet/duplicate-error.ts` documents the same trap in prose.

**Trigger surface:** Any catch around a drizzle write, and any retry-an-error loop; `apps/api/src/projects/change-requests.ts` `insertChangeRequest`, `postgres-errors.ts`, `database-errors.ts`.

**Incident:** 2026-11-07, prod API Better Stack pattern `4df56723` (1 occurrence/1 user, version 0.15.1). Two concurrent opens of a change request raced on `idx_change_requests_project_number`; the open-CR route's retry loop classified the wrapped 23505 with `/duplicate key/` against `error.message`, never matched, rethrew, and one open landed as an unhandled 500 for the customer. The fix-extraction regression test `change-requests-insert-retry.test.ts` fails on the regex form and passes on the chain form.

**Enforcement:** `apps/api/src/projects/change-requests-insert-retry.test.ts` inserts a real `DrizzleQueryError`-wrapped 23505; a matcher on the outer message rethrows and the test fails.
