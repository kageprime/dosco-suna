---
recorded: 2026-11-21T10:13:48Z
incident_date: 2026-11-21
---
# Retain immutable config releases while session history can reference their bootstrap helpers

**Rule:** Retain sealed releases for the session sandbox lifetime. A newer config does not invalidate paths recorded in conversation history or bootstrap symlinks.

**Trigger surface:** Runtime config convergence and release-store cleanup.

**Incident:** On 2026-11-21, long-lived keyed loops failed before startup after convergence deleted their earlier bootstrap release. Keeping only the current and previous releases did not cover a third release or a daemon restart.

**Enforcement:** `pi-config-release.test.ts` executes synthetic bootstrap helpers through original absolute and symlink paths after three releases and a fresh boot. `boot-config.test.ts` verifies retained content and rejects tampered or missing files.
