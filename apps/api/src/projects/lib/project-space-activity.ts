/**
 * A channel's activity: the lines its timeline draws between messages
 * ("<person> joined", "<person> added <person>", "Kortix was added by <person>").
 *
 * People come from `project_space_members` (`added_by`, `added_at`): a row
 * whose `added_by` is the person themself is a join. A backfilled row (no
 * `added_by`) has no line. Agents come from `project_space_activity`, which
 * `updateChannel` writes when the agent list changes. Someone who left has no
 * row any more, so a leave has no line. Route: `routes/project-spaces.ts`.
 */
import { SPACE_ACTIVITY_LIMIT, type SpaceActivity, type SpaceActivityList } from '@kortix/api-contract';
import { projectSpaceActivity, projectSpaceMembers } from '@kortix/db';
import { desc, eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { errorMessage } from '../../shared/error-message';
import { resolveUserIdentities } from './access';
import { memberDisplayName } from './project-space-members';

export type MemberActivityRow = { userId: string; addedBy: string | null; addedAt: Date };
export type AgentActivityRow = {
  activityId: string;
  kind: string;
  agentName: string;
  actorUserId: string | null;
  createdAt: Date;
};

/**
 * The lines, newest first, at most `limit`. `nameOf` gives a person's display
 * name, or null for someone who is no longer a person (a deleted user): their
 * own line is dropped, and as an actor they show as unknown (null).
 */
export function activityLines(
  members: readonly MemberActivityRow[],
  agents: readonly AgentActivityRow[],
  nameOf: (userId: string) => string | null,
  limit = SPACE_ACTIVITY_LIMIT,
): SpaceActivity[] {
  const actor = (userId: string | null) => {
    const name = userId ? nameOf(userId) : null;
    return userId && name !== null ? { user_id: userId, name } : null;
  };
  const lines: SpaceActivity[] = [];
  for (const row of members) {
    if (!row.addedBy) continue;
    const name = nameOf(row.userId);
    if (name === null) continue;
    const joined = row.addedBy === row.userId;
    lines.push({
      id: `member:${row.userId}`,
      kind: joined ? 'member_joined' : 'member_added',
      subject: { kind: 'person', id: row.userId, name },
      actor: joined ? null : actor(row.addedBy),
      at: row.addedAt.toISOString(),
    });
  }
  for (const row of agents) {
    if (row.kind !== 'agent_added' && row.kind !== 'agent_removed') continue;
    lines.push({
      id: row.activityId,
      kind: row.kind,
      subject: { kind: 'agent', id: row.agentName, name: row.agentName },
      actor: actor(row.actorUserId),
      at: row.createdAt.toISOString(),
    });
  }
  return lines.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1)).slice(0, limit);
}

/**
 * The channel's activity, newest first. The caller checked that the viewer may
 * see the channel. The creator's own row is no line: they made the channel,
 * they did not join it.
 */
export async function listSpaceActivity(space: { spaceId: string; createdBy: string | null }): Promise<SpaceActivityList> {
  const { spaceId } = space;
  const [members, agents] = await Promise.all([
    db
      .select({ userId: projectSpaceMembers.userId, addedBy: projectSpaceMembers.addedBy, addedAt: projectSpaceMembers.addedAt })
      .from(projectSpaceMembers)
      .where(eq(projectSpaceMembers.spaceId, spaceId))
      .orderBy(desc(projectSpaceMembers.addedAt))
      .limit(SPACE_ACTIVITY_LIMIT),
    db
      .select({
        activityId: projectSpaceActivity.activityId,
        kind: projectSpaceActivity.kind,
        agentName: projectSpaceActivity.agentName,
        actorUserId: projectSpaceActivity.actorUserId,
        createdAt: projectSpaceActivity.createdAt,
      })
      .from(projectSpaceActivity)
      .where(eq(projectSpaceActivity.spaceId, spaceId))
      .orderBy(desc(projectSpaceActivity.createdAt))
      .limit(SPACE_ACTIVITY_LIMIT),
  ]);
  const ids = new Set<string>();
  for (const row of members) {
    ids.add(row.userId);
    if (row.addedBy) ids.add(row.addedBy);
  }
  for (const row of agents) if (row.actorUserId) ids.add(row.actorUserId);
  const identities = await resolveUserIdentities([...ids]);
  const nameOf = (userId: string) => {
    const identity = identities.get(userId);
    if (!identity || identity.exists === false) return null;
    return memberDisplayName({ displayName: identity.displayName ?? null, email: identity.email ?? null });
  };
  const joins = members.filter((row) => !(space.createdBy && row.userId === space.createdBy && row.addedBy === space.createdBy));
  return { activity: activityLines(joins, agents, nameOf) };
}

/**
 * Record the agents `actorUserId` added to and removed from a channel: one row
 * each. Best effort: a failure is logged, never thrown, so the PATCH that
 * changed the list still succeeds.
 */
export async function recordAgentChanges(
  spaceId: string,
  before: readonly string[],
  after: readonly string[],
  actorUserId: string | null,
): Promise<void> {
  const rows = [
    ...after.filter((name) => !before.includes(name)).map((agentName) => ({ kind: 'agent_added', agentName })),
    ...before.filter((name) => !after.includes(name)).map((agentName) => ({ kind: 'agent_removed', agentName })),
  ];
  if (rows.length === 0) return;
  try {
    await db.insert(projectSpaceActivity).values(rows.map((row) => ({ ...row, spaceId, actorUserId })));
  } catch (error) {
    logger.warn('[spaces] the agent change was not recorded', { space_id: spaceId, error: errorMessage(error) });
  }
}
