---
recorded: 2026-11-12T09:12:44Z
incident_date: 2026-11-12
---
# Ask a person's role outside their own request with mfaAal aal2; a role check with no MFA level refuses every member of an MFA account except the super admin

**Rule:** When server code asks "does this person's role allow X" on behalf of a request that was already authorized (session create, a trigger fire, a channel message, a queued command), build the actor with `actorForUser(userId, accountId, { mfaAal: 'aal2' })`. A bare `actorForUser` reaches `authorize` step 6 (`mfaGateBlocks`, `apps/api/src/iam/authorize.ts`) with no token and no level, so in an account with `mfa_required` it denies `account_mfa_required` for everyone except the super admin, who is allowed at step 5. Keep the bare actor only where the check IS the person's own unauthenticated action (the Slack/Teams Stop button, `apps/api/src/projects/session-lifecycle/turn-stop-authority.ts`). Test every such check in an account with `mfa_required` and a non-super-admin member.

**Trigger surface:** A new `authorize(actorForUser(...))` call anywhere outside a Hono request; `apps/api/src/projects/lib/session-create.ts`; `launcherMayReadRepository` (`apps/api/src/projects/lib/launcher-repository-access.ts`); `memberMayReadProject` (`apps/api/src/secrets/account-resource.ts`).

**Incident:** 2026-11-12, prod. A session started by an account admin in a workspace that requires MFA booted with `repository_access: false` and `workspace_mode: runtime`. `GET /v1/workspaces/:id` then blanked `repo_url`, so `kortix workspaces clone` ran `git clone ''` and the run stopped before it started. #12136 (prod v0.15.4, 2026-11-10) made repository access depend on the launcher's `project.file.read`, asked through a bare `actorForUser`. The same person's sessions on 2026-11-10 before that release had `repository_access: true`; the super admin's cron sessions afterwards still had it. The same bug class was fixed for pooled provider keys on 2026-10-01 (`memberMayReadProject`) and came back through a new call site.

**Enforcement:** `apps/api/src/projects/lib/sessions.create-characterization.test.ts` pins that session create asks `launcherMayReadRepository`. `apps/api/src/__tests__/integration-launcher-repository-access.test.ts` (DB suite): in an MFA account, an admin and a project manager pass `launcherMayReadRepository`, a member with no project role does not, and the bare tokenless actor is still refused `account_mfa_required`.
