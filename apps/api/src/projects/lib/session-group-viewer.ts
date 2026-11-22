/**
 * The services half of Space access (`shared/session-group-access.ts` holds
 * the rules): the `session_groups` flag and account session oversight, which
 * `shared/` cannot read.
 */
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { hasAccountSessionOversight } from '../../iam/session-oversight';
import { db } from '../../shared/db';
import { type GroupViewer, sessionSharedThroughGroup, sharedGroupIdsFor } from '../../shared/session-group-access';

export async function groupViewerFor(userId: string, accountId: string): Promise<GroupViewer> {
  return { userId, oversight: await hasAccountSessionOversight(userId, accountId).catch(() => false) };
}

/** `sharedGroupIdsFor` while the project's `session_groups` flag is on; empty while it is off. */
export async function sharedGroupIdsWhileOn(projectId: string, userId: string): Promise<Set<string>> {
  if (!(await projectFeatureFlagEnabled(projectId, 'session_groups'))) return new Set();
  return sharedGroupIdsFor(projectId, userId);
}

/** The session is in a Space this person sees (or is a child of a session in one), with `session_groups` on. */
export async function sessionSharedThroughSpace(projectId: string, userId: string, sessionId: string): Promise<boolean> {
  if (!(await projectFeatureFlagEnabled(projectId, 'session_groups'))) return false;
  const [row] = await db
    .select({ groupId: projectSessions.groupId, parentSessionId: projectSessions.parentSessionId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return row ? sessionSharedThroughGroup(projectId, userId, row) : false;
}
