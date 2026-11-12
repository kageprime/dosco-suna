---
recorded: 2026-11-11T16:17:12Z
incident_date: 2026-11-11
---
# Drive an OAuth consent in a flow exactly as the consent page does; a test that approves without a workspace never meets the fence a bound token meets

**Rule:** A flow that runs "Sign in with Kortix" sends the consent body the consent page sends: a `workspace_id` whenever the request reports `asks_workspace: true`. When a route's fence binding (`apps/api/src/middleware/workspace-binding.ts`) or the consent's token shape changes, test the route with every credential shape that reaches it: browser session, personal key, workspace key, session token, workspace-bound and unbound OAuth token. A dispatcher route (the MCP server) that re-enters the API with the same credential binds to the credential's own workspace, never to `person`.

**Trigger surface:** Changing `WORKSPACE_BINDINGS`, the OAuth consent (`apps/api/src/oauth/index.ts`, the web consent page), or any OAuth client surface (`/v1/mcp`, the Chrome extension); writing a flow that approves consent.

**Incident:** 2026-11-11, prod v0.15.3–v0.15.6 (#11857, first released 2026-11-10). The consent page started binding every OAuth grant to one workspace, and the workspace fence classed `/v1/mcp` as a person route. Every MCP client that signed in after the release got `403 credential_fence_refused` (`person-route`) on `initialize`, `tools/list` and `tools/call`; grants made before the release kept working (2.8k–10k MCP requests a day). Prod logs: 37 refusals since 2026-11-10, 31 of them from one workspace in 3 minutes on 2026-11-11. `MCP-3` approved consent with no `workspace_id`, so it held an unbound token and stayed green. Found while reproducing an unrelated MFA follow-up on dev; a same-day change (#12429) had throttled the refusal's log line without fixing the route.

**Enforcement:** `MCP-3` (`tests/src/flows/mcp.flow.ts`) approves consent with `workspace_id`, as the page does, and fails with the prod `403` when `/v1/mcp` is bound `person`; its step "the workspace-bound token stays in its workspace" pins `list_projects` to the one workspace and `403 credential_fence_refused` on another. `unit-workspace-binding-coverage.test.ts` pins `POST /v1/mcp` allowed for workspace and session keys. None yet for the general rule: a lint that flags a flow posting `/v1/oauth/authorize/consent` without `workspace_id`.
