---
recorded: 2026-11-11T23:43:38Z
incident_date: 2026-11-11
---
# Pause an automation the account cannot run at its first refusal, and resume it by itself; never let it fire into a refusal

**Rule:** A refusal that describes the account (no usable model, an empty wallet, no plan) pauses the trigger at the first refused fire, with the refusal as the reason, and a scheduler pass resumes it once the cause is gone. A save that leaves a trigger on runs the same check the fire runs. Never retry, dead-letter or alert per slot on account state; never leave it to a 24-hour failure streak.

**Trigger surface:** You add a refusal to a fire path (`trigger-fire.ts`, a webhook or cron fire, a reminder), a new billing or model gate, or a new save path for triggers (API route, CLI, kortix.yaml sync).

**Incident:** Prod audit 2026-11-11. 36 accounts with no usable model saved triggers that dead-lettered every fire "No usable model"; 19 were auto-paused only by the 24-hour failure rule. 21 accounts with an empty wallet ran cron triggers into the billing gate ~6.9k times in 14 days (~6.8k refused session creates). Same audit: 28 accounts added an MCP server, never signed in, and the catalog sync stored the 401 as connector `error` instead of Sign in. Fix: branch `trigger-setup-gates`, `apps/api/src/projects/lib/trigger-setup-pause.ts`, `mcpCatalogAwaitsSignIn` in `apps/api/src/connectors/sync.ts`.

**Enforcement:** `apps/api/src/__tests__/integration-trigger-setup-pause.test.ts` and `apps/api/src/__tests__/integration-mcp-awaits-sign-in.test.ts` (`core-db` lane); flow `TRG-42` (`core-flows`).
