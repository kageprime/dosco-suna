---
recorded: 2026-11-12T12:38:51Z
incident_date: 2026-11-08
---
# Cap an in-place recovery the provider accepts but never boots: count accepted attempts and preserve the identity as lost at the cap

**Rule:** A provider answer that accepts a recovery (`recovering`) is not proof the box will boot. Count every accepted in-place recovery of an identity in `runtimeRecoveryAttempts`, clear the count only when the box is proven `running`, and let `recoverRemovedParkedRuntime` preserve the identity as lost once the count reaches `MAX_IN_PLACE_RECOVERY_ATTEMPTS` (3). A new path that accepts a recovery writes through `markInPlaceRuntimeRecoveryAccepted`, so it counts too.

**Trigger surface:** `recoverInPlace` in a provider, `projects/runtime-identity.ts` (claim, accept, preserve), `reaping/parked-runtime-verification.ts`, `reaping/stuck-provisioning.ts`, and any loop that retries on a provider's acceptance.

**Incident:** 2026-11-08..11 prod. One Platinum host ran short of disk; four internal sessions' boxes stopped without saving memory and then failed every cold boot (`failed-start`). Platinum maps `failed-start` to `removed`, and its `recoverInPlace` answers `recovering` and calls `/start` for a box that booted before. The stuck-provisioning lane (gated by the 2026-11-02 entry) took a new recovery lease every 10 min, about 20 failed starts an hour for 3 days, and the boot failures kept tripping the host's boot-health cordon. The four rows stayed `provisioning`, which held the workspace at the trigger backpressure limit (3), and every Slack mention there answered "I've queued your task behind the sessions already starting up" although the create started 1 s later. Rows marked lost by hand 2026-11-11 18:12Z. PR #12567 added the cap and made Slack, Teams, Telegram, Email and Discord create inline; only trigger fires queue.

**Enforcement:** `apps/api/src/__tests__/integration-in-place-recovery-cap.test.ts` drives the real stuck-provisioning lane against PostgreSQL: three accepted recoveries, then a preserved loss and no fourth start (red with the cap disabled); a boot clears the count. `parked-runtime-verification.test.ts` pins the cap in `decideRemovedParkedOutcome`.
