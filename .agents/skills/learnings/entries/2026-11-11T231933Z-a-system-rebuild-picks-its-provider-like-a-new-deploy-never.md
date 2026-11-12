---
recorded: 2026-11-11T23:19:33Z
incident_date: 2026-11-10
---
# A system rebuild picks its provider like a new deploy; never copy a legacy provider forward

**Rule:** A rebuild that the platform queues by itself (a runtime refresh, a migration, a heal) chooses its sandbox provider with the same function a new deploy uses (`chooseReleaseProvider`). It never copies the provider of the deployment it replaces. When you retire a provider or revoke its key, probe that key at the vendor (`200` vs `401`) and list every row that still names that provider.

**Trigger surface:** You write code that inserts an `app_deployments` row or a sandbox for an existing App or session. You retire or rotate a sandbox provider key.

**Incident:** 2026-11-10 21:39 UTC, the prod release with a new App supervisor (`appd-7af8…`). `enqueueCurrentAppRuntime` queued one system refresh per App and copied `hosting_provider`. 8 Apps were still active on legacy Daytona, whose shared API key (one value in every env file and Secrets Manager blob) answered `401 Invalid credentials`. 52 refreshes in 2 accounts failed with "Snapshot build failed: Invalid credentials", plus 5 `attempts_exhausted`, retried every hour. A new deploy of the same Apps already chose Platinum. Fix: PR #12492, `refreshHostingProvider`.

**Enforcement:** `apps/api/src/apps/keep-alive.integration.test.ts` ("a refresh of a legacy Daytona App builds on Platinum…") in the `core-db` lane. None yet for a dead provider key: the enforcer to build is a daily probe of each configured sandbox provider key that alerts on `401`.
