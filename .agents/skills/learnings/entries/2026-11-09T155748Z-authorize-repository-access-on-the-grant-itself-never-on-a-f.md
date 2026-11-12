---
recorded: 2026-11-09T15:57:48Z
incident_date: 2026-11-09
---
# Authorize repository access on the grant itself, never on a flag a config key sets

**Rule:** Every path that hands a session repository bytes checks the grant: the session's actor (owner role ∩ agent grant) must hold `project.gitops.read`. Never let a session-row flag that a `kortix.yaml` key wrote be the only check. When you remove or repurpose a config key, list every reader of the flag it set, and move each reader to a grant check before the key goes.

**Trigger surface:** Removing or changing an agent key in `kortix.yaml`, touching `repository_access` / `workspace_mode` on `project_sessions.metadata`, the Git proxy authorization (`authorizeGitProxy` in `apps/api/src/projects/lib/git.ts`), the config release variant (`releaseVariantFor`), the compiled config a box gets, or the project image gate (`projectImageAllowedForSession`).

**Incident:** 2026-11-09, the no-config-clone branch (removing `agents.<name>.workspace`, no auto-clone at boot). Found before merge; nothing shipped. The per-agent `workspace: { project_repository: false }` wrote `repository_access: false` on the session row, and that flag was the only check on four disclosure paths: the Git proxy for the sandbox token and for a same-account session PAT (neither asked IAM), the one-agent config release variant, the one-agent compiled config, and the project image. Deleting the key made every new session read as allowed, so a white-label tenant agent with `kortix_permissions: none` could have cloned the whole project repository with its own `KORTIX_TOKEN` and received every agent's prompt. Fixed on the branch: the Git proxy requires `project.gitops.read` for both session paths, session create derives `repository_access` from the agent grant and the person's `project.file.read` (`agentGrantAllowsRepository`), and the `agent-workspace` rewrite turns `project_repository: true` into `workspace.gitops.read` so agents that had the checkout keep it.

**Enforcement:** `apps/api/src/__tests__/unit-git-proxy-authz.test.ts` (a session without the grant, and a session with no token row, get 403), `apps/api/src/projects/agents-grants.test.ts` (`agentGrantAllowsRepository` per grant shape), `packages/manifest-schema/src/__tests__/deprecations.test.ts` (the rewrite adds the grant), and flow `SESS-28` (from inside a real box, `/files` and Git `info/refs` answer 403 without the grant, 200 with it).
