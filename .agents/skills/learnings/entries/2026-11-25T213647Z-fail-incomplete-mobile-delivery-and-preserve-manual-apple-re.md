---
recorded: 2026-11-25T21:36:47Z
incident_date: 2026-11-25
---
# Fail incomplete mobile delivery and preserve manual Apple release gates

**Rule:** Treat blocked or superseded iOS submissions as incomplete delivery, and preserve an explicit manual Apple release gate.

**Trigger surface:** Changing the Mobile Store release script.

**Incident:** 2026-11-25, KRTX-5194. Android completed while iOS stopped after upload. Separate blocked-state paths also returned success and an approved manual hold was automatically released.

**Enforcement:** `bun test apps/mobile/scripts/store-release.test.ts` exercises blocked, superseded, pending-review and manual-release Apple responses and partial-platform failure.
