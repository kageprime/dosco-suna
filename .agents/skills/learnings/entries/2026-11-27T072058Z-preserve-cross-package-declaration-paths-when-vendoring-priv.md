---
recorded: 2026-11-27T07:20:58Z
incident_date: 2026-11-27
---
# Preserve cross-package declaration paths when vendoring private UI types

**Rule:** Emit private declarations from the common packages root, preserving their relative paths. A shared declaration may reference the SDK's dependency-free IAM literals. Never emit that declaration outside the declared root or leave its relative import unresolved.

**Trigger surface:** `packages/ui/scripts/build.mjs`, private-package vendoring, and moves of shared type definitions into the SDK.

**Incident:** The November 27 nightly failed both UI artifact builds and the publish lane. Shared workspace actions imported SDK IAM literals outside the shared-only declaration root, producing TS6059. Emitting the shared and SDK declarations under the same vendor root preserves the relative import.

**Enforcement:** `packages/ui/scripts/publish-build.test.ts` exercises the real builder. `packages/ui/scripts/smoke-install.mjs` packs and installs the artifact, imports its exports, and checks its published declarations.
