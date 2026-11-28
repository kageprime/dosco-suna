---
recorded: 2026-11-24T22:32:29Z
incident_date: 2026-11-24
---
# Keep graduated capabilities and their test fixtures synchronized

**Rule:** When a capability graduates or its default changes, update the shipped skill metadata and boundary fixtures in the same change. A private connect request does not exercise the shared-account write gate.

**Trigger surface:** Removing a feature flag, changing connector ownership defaults, or adding API routes.

**Incident:** 2026-11-24, KRTX-5129. The nightly Tests run failed in core-db, packages-api and packages-rest. Independent failures included retired Chrome metadata, a private-default connect fixture, missing audit labels, an unused icon and a missing feature-hook stub.

**Enforcement:** `managed-skills-drift.test.ts`, `integration-project-write-leaf-gates-http.test.ts`, `unit-audit-route-labels.test.ts`, `icon-imports.test.ts` and `review-page-permissions.test.tsx` reproduce these boundaries.
