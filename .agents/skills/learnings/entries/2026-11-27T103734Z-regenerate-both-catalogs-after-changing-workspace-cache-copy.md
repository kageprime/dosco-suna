---
recorded: 2026-11-27T10:37:34Z
incident_date: 2026-11-27
---
# Regenerate both catalogs after changing workspace-cache copy

**Rule:** After changing workspace-cache audit titles or English feature-flag copy, run `bun apps/web/scripts/generate-audit-actions-doc.mjs` and `node packages/ui/scripts/gen-i18n-catalog.mjs`. Commit both generated outputs with their inputs.

**Trigger surface:** Changing shared audit labels or the English catalog consumed by @kortix/ui.

**Incident:** 2026-11-27, KRTX-5235: the first repair shortened the workspace-cache audit title and changed project wording to workspace wording. Its generated audit reference and bundled English catalog retained the old text. Two nightly Tests lanes remained red after merge a199aee; both existing checks failed locally before regeneration.

**Enforcement:** Existing `tests/unit/audit-actions-doc.test.ts` and `packages/ui/src/i18n/i18n.test.tsx` compare the generated outputs with their canonical inputs. Keep both checks unchanged.
