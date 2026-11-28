---
recorded: 2026-11-25T21:53:52Z
incident_date: 2026-11-25
---
# Preserve existing App Store release policies when submitting review

**Rule:** Never overwrite releaseType or earliestReleaseDate on an existing App Store version or a renamed draft.

**Trigger surface:** Submitting an iOS store version for App Review.

**Incident:** 2026-11-25, PR #13090 review. Editable manual and scheduled versions were changed to automatic release before submission.

**Enforcement:** `bun test apps/mobile/scripts/store-release.test.ts` exercises existing, renamed and newly created versions through the Apple adapter.
