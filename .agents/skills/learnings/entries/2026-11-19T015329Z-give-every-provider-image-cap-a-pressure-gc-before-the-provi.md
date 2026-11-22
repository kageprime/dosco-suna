---
recorded: 2026-11-19T01:53:29Z
incident_date: 2026-11-19
---
# Give every provider image cap a pressure GC before the provider ships to prod

**Rule:** A provider that caps how many images an org holds gets a pass in the snapshot quota GC (`apps/api/src/snapshots/quota-gc.ts`) before Kortix runs on it in prod. Every content-addressed image name (`kortix-tpl-`, `kortix-default-`) leaks one image per identity change, and a best-effort same-name reap does not bound the count: it gives up on `409 template_in_use` and never retries.

**Trigger surface:** Adding or switching a sandbox provider, adding an image namespace, or reading a build error with `org_template_quota_exceeded` / `error_category: quota`.

**Incident:** 2026-11-19, v0.16.0. The prod Platinum org held 500/500 templates: 289 `kortix-tpl-`, 85 `kortix-default-`, 30 failed builds, the oldest from 2026-06-19. The quota GC ran for Daytona only. Every build in the org failed with `429 org_template_quota_exceeded`, including the v0.16.0 platform default: the newest `kortix-default-` in the org was from 2026-11-14. A prod workspace showed "Sandbox build failing" with 25 failed builds in 90 min. Mitigation: 322 templates deleted by hand (unreferenced by the prod DB, failed, or past the 12 newest defaults); 22 refused with `409 template_in_use` and stayed. The org went to 208/500 and the next build passed.

**Enforcement:** `apps/api/src/snapshots/quota-gc-platinum.test.ts` drives one Platinum pass through a fake control plane at 500/500 and asserts the reclaimed set. The maintenance heartbeat logs `platinum_templates_org=<n>`; the pass logs `[snapshot-gc] BUDGET UNRESOLVED: provider=platinum` when it cannot reach 70% of `PLATINUM_TEMPLATE_QUOTA`. None yet for a new provider: nothing fails when a provider ships without a pass.
