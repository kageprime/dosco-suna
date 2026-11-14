import { PROJECT_ACTIONS } from '../../iam/actions';
import { actorForUser } from '../../iam/actor';
import { authorize } from '../../iam/authorize';

/**
 * Does the person who launches a session hold `project.file.read` on its
 * project? Session create ANDs this with the agent's `project.gitops.read`
 * grant to decide `repository_access`.
 *
 * A question about the person's role, not about a request: the create route
 * already authorized its request at that request's MFA level, and a trigger,
 * channel or queued create has no level at all. Asked with no level, the
 * account-MFA gate (authorize step 6) refused every member of an MFA account
 * except the super admin. Their sessions booted with `repository_access:
 * false`, and `kortix workspaces clone` ran `git clone ''` (prod, 2026-11-12).
 * The same rule as `memberMayReadProject` (secrets/account-resource.ts).
 * Never use it as a request's own check: it skips that request's MFA level.
 */
export async function launcherMayReadRepository(userId: string, accountId: string, projectId: string): Promise<boolean> {
  return (await authorize(actorForUser(userId, accountId, { mfaAal: 'aal2' }), PROJECT_ACTIONS.PROJECT_FILE_READ, {
    type: 'project',
    id: projectId,
  })).allowed;
}
