/**
 * Session groups: named folders of a project's sessions in the sidebar, one
 * table `kortix.project_session_groups`, behind the `session_groups` flag. The
 * routes live in `routes/session-groups.ts`.
 *
 * Every project member sees the same groups in the same order (`position`,
 * 0-based, no gaps). A session is in at most one group of its own project
 * (`project_sessions.group_id`). Filing a session never touches its
 * `updated_at`, so it keeps its place in every activity-ordered list. Deleting
 * a group leaves its sessions in no group (the FK's ON DELETE SET NULL).
 *
 * Every write that reads or changes the order takes the project's advisory
 * lock first, so two creates never take one position and a reorder never
 * races a create or a delete. A write that moves sessions between lists
 * (filing, deleting a group) forgets this replica's memoized list pages, so
 * the next list read is computed again, never a 304 from before the write.
 *
 * Only a top-level session is filed: a session another session started
 * (`parent_session_id`, or the older `metadata.spawned_by_session`) stays
 * with its parent.
 */
import { SESSION_GROUPS_MAX, type SessionGroupIcon, type SpaceTab } from '@kortix/api-contract';
import { accountMembers, projectSessionGroupMembers, projectSessionGroups, projectSessions } from '@kortix/db';
import { isProjectGlyphName, normalizeProjectGlyphColor, suggestSpaceIcon } from '@kortix/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { errorSqlstate } from '../../shared/error-cause';
import { uniqueViolationConstraint } from '../../shared/postgres-errors';
import { forgetSessionListPollEtags } from './session-list-poll-memo';
import { normalizeProjectIcon } from './project-icon';
import { storedSpaceTabs } from './project-spaces';

export type SessionGroupRow = typeof projectSessionGroups.$inferSelect;

const NAME_INDEX = 'uniq_project_session_groups_name';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function lockProjectGroups(tx: Tx, projectId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-groups:${projectId}`}))`);
}

function groupsOf(executor: Tx | typeof db, projectId: string) {
  return executor
    .select()
    .from(projectSessionGroups)
    .where(eq(projectSessionGroups.projectId, projectId))
    .orderBy(asc(projectSessionGroups.position), asc(projectSessionGroups.createdAt), asc(projectSessionGroups.groupId));
}

/**
 * A group icon the API may store and every client can draw: one emoji
 * grapheme (`normalizeProjectIcon`, the project icon's rule), or a catalogue
 * glyph in a preset colour or `#rrggbb`. Null for anything else, including a
 * stored value a later catalogue no longer has.
 */
export function normalizeSessionGroupIcon(input: unknown): SessionGroupIcon | null {
  if (!input || typeof input !== 'object') return null;
  if ('emoji' in input) {
    const emoji = normalizeProjectIcon((input as { emoji: unknown }).emoji);
    return emoji ? { emoji } : null;
  }
  if ('glyph' in input) {
    const glyph = (input as { glyph: unknown }).glyph;
    if (!glyph || typeof glyph !== 'object') return null;
    const { name, color } = glyph as { name?: unknown; color?: unknown };
    const normalizedColor = normalizeProjectGlyphColor(color);
    return isProjectGlyphName(name) && normalizedColor ? { glyph: { name, color: normalizedColor } } : null;
  }
  return null;
}

/** The project's groups, in order. */
export function listSessionGroups(projectId: string): Promise<SessionGroupRow[]> {
  return groupsOf(db, projectId);
}

/** A new group, last in the order. `name` and `description` are already trimmed (the contract schema). */
export async function createSessionGroup(input: {
  accountId: string;
  projectId: string;
  name: string;
  description?: string | null;
  /** Already checked (`normalizeSessionGroupIcon`). Absent: the icon the name suggests. */
  icon?: SessionGroupIcon;
  createdBy: string | null;
}): Promise<{ ok: true; group: SessionGroupRow } | { ok: false; code: 'group_name_taken' | 'group_limit' }> {
  try {
    return await db.transaction(async (tx) => {
      await lockProjectGroups(tx, input.projectId);
      const existing = await groupsOf(tx, input.projectId);
      if (existing.length >= SESSION_GROUPS_MAX) return { ok: false as const, code: 'group_limit' as const };
      const [group] = await tx
        .insert(projectSessionGroups)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          name: input.name,
          description: input.description || null,
          icon: input.icon ?? suggestSpaceIcon(input.name),
          position: existing.length,
          createdBy: input.createdBy,
        })
        .returning();
      return { ok: true as const, group: group! };
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) === NAME_INDEX) return { ok: false, code: 'group_name_taken' };
    throw error;
  }
}

/**
 * Rename a group of the project, change its description or its icon. Its own
 * name in another case is free. An empty description clears it; `icon: null`
 * takes the icon off (clients then draw the suggested one). The icon is
 * already checked (`normalizeSessionGroupIcon`).
 */
export async function updateSessionGroup(
  projectId: string,
  groupId: string,
  input: { name?: string; description?: string | null; icon?: SessionGroupIcon | null },
): Promise<{ ok: true; group: SessionGroupRow } | { ok: false; code: 'group_name_taken' | 'group_not_found' }> {
  try {
    const [group] = await db
      .update(projectSessionGroups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)))
      .returning();
    return group ? { ok: true, group } : { ok: false, code: 'group_not_found' };
  } catch (error) {
    if (uniqueViolationConstraint(error) === NAME_INDEX) return { ok: false, code: 'group_name_taken' };
    throw error;
  }
}

/**
 * Put the groups the caller sees in this order. `groupIds` must name every
 * group in `visible` exactly once (every group of the project when absent);
 * otherwise nothing changes and the answer is `group_order_stale` (the
 * caller's list is out of date). A group the caller does not see keeps its
 * place: the caller's groups fill the places theirs held, in the new order.
 */
export async function reorderSessionGroups(
  projectId: string,
  groupIds: readonly string[],
  visible?: (groupId: string) => boolean,
): Promise<{ ok: true; groups: SessionGroupRow[] } | { ok: false; code: 'group_order_stale' }> {
  return db.transaction(async (tx) => {
    await lockProjectGroups(tx, projectId);
    const existing = await groupsOf(tx, projectId);
    const seen = visible ? existing.filter((group) => visible(group.groupId)) : existing;
    const known = new Set(seen.map((group) => group.groupId));
    if (
      groupIds.length !== seen.length ||
      new Set(groupIds).size !== groupIds.length ||
      groupIds.some((id) => !known.has(id))
    ) {
      return { ok: false as const, code: 'group_order_stale' as const };
    }
    const queue = [...groupIds];
    const order = existing.map((group) => (known.has(group.groupId) ? queue.shift()! : group.groupId));
    const now = new Date();
    for (const [position, groupId] of order.entries()) {
      const current = existing.find((group) => group.groupId === groupId)!;
      if (current.position === position) continue;
      await tx
        .update(projectSessionGroups)
        .set({ position, updatedAt: now })
        .where(eq(projectSessionGroups.groupId, groupId));
    }
    return { ok: true as const, groups: await groupsOf(tx, projectId) };
  });
}

/** Delete a group of the project; its sessions go to no group and the rest close up. False when there is no such group. */
export async function deleteSessionGroup(projectId: string, groupId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockProjectGroups(tx, projectId);
    const [deleted] = await tx
      .delete(projectSessionGroups)
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)))
      .returning({ position: projectSessionGroups.position });
    if (!deleted) return false;
    forgetSessionListPollEtags(projectId);
    await tx
      .update(projectSessionGroups)
      .set({ position: sql`${projectSessionGroups.position} - 1` })
      .where(
        and(
          eq(projectSessionGroups.projectId, projectId),
          sql`${projectSessionGroups.position} > ${deleted.position}`,
        ),
      );
    return true;
  });
}

/**
 * File a top-level session of the project into one of the project's groups, or
 * into no group (`null`). `updated_at` is left as it is. The caller has already
 * checked that the person may see the session.
 */
export async function setSessionGroup(
  projectId: string,
  sessionId: string,
  groupId: string | null,
): Promise<
  { ok: true; groupId: string | null } | { ok: false; code: 'group_not_found' | 'session_not_found' | 'child_session' }
> {
  const [session] = await db
    .select({ parent: projectSessions.parentSessionId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)));
  if (!session) return { ok: false, code: 'session_not_found' };
  if (session.parent || typeof session.metadata?.spawned_by_session === 'string') {
    return { ok: false, code: 'child_session' };
  }
  if (groupId !== null) {
    const [group] = await db
      .select({ groupId: projectSessionGroups.groupId })
      .from(projectSessionGroups)
      .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)));
    if (!group) return { ok: false, code: 'group_not_found' };
  }
  try {
    const [row] = await db
      .update(projectSessions)
      .set({ groupId })
      .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
      .returning({ groupId: projectSessions.groupId });
    if (!row) return { ok: false, code: 'session_not_found' };
    forgetSessionListPollEtags(projectId);
    return { ok: true, groupId: row.groupId };
  } catch (error) {
    // The group was deleted between the read above and this write: the FK
    // refuses the stale id (23503).
    if (errorSqlstate(error) === '23503') return { ok: false, code: 'group_not_found' };
    throw error;
  }
}

/** A group of the project, or null. */
export async function findSessionGroup(projectId: string, groupId: string): Promise<SessionGroupRow | null> {
  const [group] = await db
    .select()
    .from(projectSessionGroups)
    .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)));
  return group ?? null;
}

/**
 * Who sees a group: `private` with `memberIds` (none: only its creator) or
 * `project` (members cleared). Every id must be a member of the project's
 * account (`not_a_member` otherwise, nothing changes); the creator is never
 * listed. One transaction.
 */
export async function setSessionGroupSharing(input: {
  projectId: string;
  accountId: string;
  groupId: string;
  visibility: 'private' | 'project';
  memberIds: readonly string[];
  addedBy: string;
}): Promise<{ ok: true; group: SessionGroupRow; memberIds: string[] } | { ok: false; code: 'group_not_found' | 'not_a_member' }> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(projectSessionGroups)
      .where(and(eq(projectSessionGroups.projectId, input.projectId), eq(projectSessionGroups.groupId, input.groupId)))
      .for('update');
    if (!group) return { ok: false as const, code: 'group_not_found' as const };
    const wanted = input.visibility === 'project' ? [] : input.memberIds.filter((id) => id !== group.createdBy);
    if (wanted.length > 0) {
      const found = await tx
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, input.accountId), inArray(accountMembers.userId, wanted)));
      if (found.length !== wanted.length) return { ok: false as const, code: 'not_a_member' as const };
    }
    const [updated] = await tx
      .update(projectSessionGroups)
      .set({ visibility: input.visibility, updatedAt: new Date() })
      .where(eq(projectSessionGroups.groupId, input.groupId))
      .returning();
    await tx.delete(projectSessionGroupMembers).where(eq(projectSessionGroupMembers.groupId, input.groupId));
    if (wanted.length > 0) {
      await tx
        .insert(projectSessionGroupMembers)
        .values(wanted.map((userId) => ({ groupId: input.groupId, userId, addedBy: input.addedBy })));
    }
    // Who sees the group's sessions changed: no list page may answer from before.
    forgetSessionListPollEtags(input.projectId);
    return { ok: true as const, group: updated!, memberIds: wanted };
  });
}

/**
 * Replace a group's tabs (already validated: `SpaceTabsInputSchema`). A link
 * tab's `embeddable` is the server's, as for a channel (`storedSpaceTabs`).
 */
export async function setSessionGroupTabs(
  projectId: string,
  group: Pick<SessionGroupRow, 'groupId' | 'tabs'>,
  tabs: readonly SpaceTab[],
): Promise<SessionGroupRow | null> {
  const stored = await storedSpaceTabs(group.tabs, tabs);
  const groupId = group.groupId;
  const [updated] = await db
    .update(projectSessionGroups)
    .set({ tabs: stored, updatedAt: new Date() })
    .where(and(eq(projectSessionGroups.projectId, projectId), eq(projectSessionGroups.groupId, groupId)))
    .returning();
  return updated ?? null;
}

/** One group's activity: its top-level sessions and when the newest of them last changed. */
export interface SessionGroupActivity {
  sessionCount: number;
  lastActivityAt: Date | null;
}

/**
 * The activity of each group: its top-level, live sessions (soft-deleted ones
 * excluded) and their newest `updated_at`. One grouped query over the
 * `(group_id, updated_at)` index. A group with no session has no entry.
 */
export async function sessionGroupActivity(projectId: string, groupIds: readonly string[]): Promise<Map<string, SessionGroupActivity>> {
  const out = new Map<string, SessionGroupActivity>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({
      groupId: projectSessions.groupId,
      sessionCount: sql<number>`count(*)::int`,
      lastActivityAt: sql<Date | null>`max(${projectSessions.updatedAt})`,
    })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        inArray(projectSessions.groupId, [...groupIds]),
        sql`${projectSessions.parentSessionId} is null`,
        sql`(${projectSessions.metadata} ? 'deletedAt') is not true`,
      ),
    )
    .groupBy(projectSessions.groupId);
  for (const row of rows) {
    if (!row.groupId) continue;
    out.set(row.groupId, { sessionCount: row.sessionCount, lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt) : null });
  }
  return out;
}
