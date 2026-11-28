---
recorded: 2026-11-25T06:40:24Z
incident_date: 2026-11-25
---
# Regenerate UI styles and register browser specs before handoff

**Rule:** Run `pnpm --filter @kortix/ui build:styles` after adding component classes. Register a new browser spec in both duration tables before handoff; use the existing median as an explicit provisional weight until CI measurements exist.

**Trigger surface:** UI class additions and new files under `tests/e2e/specs/`.

**Incident:** 2026-11-25, KRTX-5154. Tests run 45555531270 failed in packages-rest on stylesheet drift and core-db on a missing browser-shard row. Rebuilding with the earlier question prompt exactly reproduced the committed stylesheet; the current prompt adds `m-3`. Journey 61 was absent from both tables.

**Enforcement:** `packages/ui/src/styles/stylesheet-coverage.test.ts` executes the stylesheet builder with `--check`. `tests/unit/browser-shard.test.ts` checks coverage and complete, nonduplicated partitions for both targets.
