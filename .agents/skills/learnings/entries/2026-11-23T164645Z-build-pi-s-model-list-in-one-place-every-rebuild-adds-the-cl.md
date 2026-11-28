---
recorded: 2026-11-23T16:46:45Z
incident_date: 2026-11-12
---
# Build pi's model list in one place; every rebuild adds the Claude provider

**Rule:** Every path that rebuilds pi's model list (boot, reconfigure, refresh) calls `PiRuntime.buildModels()` in `harness/pi/runtime.ts`. Never call `createPiModels()` with a hand-copied argument list: a rebuild without `claude` turns a `claude-agent/<id>` ref into a plain gateway model.

**Trigger surface:** Adding a provider to pi, or a new path that rebuilds or reloads the model list (an env push, a config release, a restart).

**Incident:** 2026-11-12 to 2026-11-23, since #11283. `applyReconfigure()` rebuilt the list without the Claude provider. A Claude subscription turn that started before the background refresh finished went to the gateway's chat completions: 400 `model_not_found` "runs through Claude Code inside sessions only". 9 prod sessions lost a turn, most of them their first one. Fixed in PR #13020.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` ("a Claude subscription turn right after a reconfigure runs in Claude Code, not as a gateway model").
