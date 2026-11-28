---
recorded: 2026-11-26T16:04:46Z
incident_date: 2026-11-26
---
# Include imported policy in session grant provenance

**Rule:** Identify the complete merged policy when stamping a grant from a manifest with imports. Preserve root-blob provenance for a single-file manifest.

**Trigger surface:** Resolving agent grants for session prompts and connector authorization.

**Incident:** KRTX-1702, production versions 0.16.0 through 0.16.5. An imported agent edit leaves the root blob unchanged. The grant reconciliation guard therefore mistakes a genuine policy edit for same-blob drift and performs a confirming read while logging an error. A real Git regression reproduced the unchanged revision after the connector grant changed.

**Enforcement:** `apps/api/src/projects/git/manifest-imports.integration.test.ts` checks imported widening and narrowing, repeat reads, unrelated commits, and single-file blob compatibility. `session-token-grant-provenance.test.ts` retains the same-manifest, stale-commit and unreadable-manifest guards.
