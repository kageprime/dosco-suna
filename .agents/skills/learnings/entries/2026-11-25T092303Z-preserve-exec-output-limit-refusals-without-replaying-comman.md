---
recorded: 2026-11-25T09:23:03Z
incident_date: 2026-11-25
---
# Preserve exec output-limit refusals without replaying commands

**Rule:** Return a typed 413 for a Platinum POST sandbox exec output-limit refusal. Never replay the command or add Retry-After.

**Trigger surface:** Classifying provider exec failures in the API HTTP error handler.

**Incident:** KRTX-3036 reoccurred on 2026-11-25 as an output-limit 413, not another gateway timeout. Better Stack grouped both at the same generic throw site. The previous 504 fix was already in production.

**Enforcement:** `apps/api/src/__tests__/unit-platinum-exec-timeout.test.ts` verifies the 413 response, no Sentry capture, one provider call, no retry header, and generic handling on other methods and paths.
