/**
 * Who may see and change a Space (a session group, flag `session_groups`).
 *
 * - See: a `project` group, everyone in the project; a `private` group, its
 *   creator and its members (`project_session_group_members`). An owner or
 *   admin under account session oversight sees every group.
 * - Edit (name, description, tabs, filing sessions): everyone who sees it.
 * - Manage (sharing, delete): its creator, or an owner or admin under
 *   oversight.
 *
 * Seeing a group shares the sessions in it: `sharedGroupIdsFor` is the set the
 * session readers widen visibility with (`session-list.ts`,
 * `isProjectSessionVisibleTo`). It never includes oversight: oversight already
 * opens every session on its own path. Widening only adds viewers, so a reader
 * that misses the set hides a session, never shows one.
 */
import { projectSessionGroupMembers, projectSessionGroups } from '@kortix/db';
import { sessionGroupDriveFolder } from '@kortix/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { qualifiedColumn } from './sql-qualified-column';

export interface GroupViewer {
  userId: string;
  /** Account session oversight resolved for this person (owner or admin, policy on). */
  oversight: boolean;
}

interface GroupAccessRow {
  visibility: string;
  createdBy: string | null;
}

export function canSeeGroup(row: GroupAccessRow, memberIds: readonly string[], viewer: GroupViewer): boolean {
  return row.visibility === 'project' || viewer.oversight || row.createdBy === viewer.userId || memberIds.includes(viewer.userId);
}

export function canManageGroup(row: GroupAccessRow, viewer: GroupViewer): boolean {
  return row.createdBy === viewer.userId || viewer.oversight;
}

/** Each group's members, in the order they were added. */
export async function groupMemberIds(groupIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: projectSessionGroupMembers.groupId, userId: projectSessionGroupMembers.userId })
    .from(projectSessionGroupMembers)
    .where(inArray(projectSessionGroupMembers.groupId, [...groupIds]))
    .orderBy(projectSessionGroupMembers.addedAt);
  for (const row of rows) out.get(row.groupId)?.push(row.userId);
  return out;
}

/** When each member was added to each group: group id -> user id -> time. */
export async function groupMemberAddedAt(groupIds: readonly string[]): Promise<Map<string, Map<string, Date>>> {
  const out = new Map<string, Map<string, Date>>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: projectSessionGroupMembers.groupId, userId: projectSessionGroupMembers.userId, addedAt: projectSessionGroupMembers.addedAt })
    .from(projectSessionGroupMembers)
    .where(inArray(projectSessionGroupMembers.groupId, [...groupIds]));
  for (const row of rows) {
    const group = out.get(row.groupId) ?? new Map<string, Date>();
    group.set(row.userId, row.addedAt);
    out.set(row.groupId, group);
  }
  return out;
}

/**
 * The project's groups whose sessions this person sees through the group: a
 * `project` group, one they created, or one shared with them. The caller
 * checks the `session_groups` flag first (a group shares nothing while off):
 * `shared/` cannot read flags.
 */
export async function sharedGroupIdsFor(projectId: string, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ groupId: projectSessionGroups.groupId })
    .from(projectSessionGroups)
    .where(
      and(
        eq(projectSessionGroups.projectId, projectId),
        sql`(${qualifiedColumn(projectSessionGroups.visibility)} = 'project'
          or ${qualifiedColumn(projectSessionGroups.createdBy)} = ${userId}::uuid
          or exists (select 1 from ${projectSessionGroupMembers} m
                      where m.group_id = ${qualifiedColumn(projectSessionGroups.groupId)} and m.user_id = ${userId}::uuid))`,
      ),
    );
  return new Set(rows.map((row) => row.groupId));
}

/**
 * The group a session reads its space from: its own, or for a session another
 * session started, its parent's (a child is never filed itself).
 */
export async function sessionGroupIdOf(row: {
  groupId: string | null;
  parentSessionId: string | null;
  metadata: unknown;
}): Promise<string | null> {
  if (row.groupId) return row.groupId;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const parent = row.parentSessionId ?? (typeof meta.spawned_by_session === 'string' ? meta.spawned_by_session : null);
  if (!parent) return null;
  const rows = (await db.execute(
    sql`select group_id from kortix.project_sessions where session_id = ${parent} limit 1`,
  )) as unknown as Array<{ group_id: string | null }>;
  return rows[0]?.group_id ?? null;
}

/** True when the session is in a group this person sees (`sharedGroupIdsFor`), so the group shares it with them. */
export async function sessionSharedThroughGroup(
  projectId: string,
  userId: string | null,
  row: { groupId: string | null; parentSessionId: string | null; metadata: unknown },
): Promise<boolean> {
  if (!userId) return false;
  const groupId = await sessionGroupIdOf(row);
  if (!groupId) return false;
  return (await sharedGroupIdsFor(projectId, userId)).has(groupId);
}

/**
 * The project's Space folders (`sessionGroupDriveFolder`: all of them are
 * reserved, like private channel folders) and the ones this caller reaches:
 * a person, every group they see; a session-bound credential, only its own
 * session's group, while its person still sees it.
 */
export async function groupFolderAccess(
  projectId: string,
  userId: string,
  bound: string | null,
  /** Account session oversight for this person, asked only when the project has a group. */
  oversight: (accountId: string) => Promise<boolean>,
): Promise<{ all: Set<string>; visible: Set<string> }> {
  const rows = await db
    .select({ groupId: projectSessionGroups.groupId, visibility: projectSessionGroups.visibility, createdBy: projectSessionGroups.createdBy, accountId: projectSessionGroups.accountId })
    .from(projectSessionGroups)
    .where(eq(projectSessionGroups.projectId, projectId));
  const all = new Set<string>();
  const visible = new Set<string>();
  if (rows.length === 0) return { all, visible };
  const members = await groupMemberIds(rows.map((row) => row.groupId));
  const viewer: GroupViewer = { userId, oversight: bound === null && (await oversight(rows[0]!.accountId).catch(() => false)) };
  const own = bound
    ? await sessionGroupIdOf(
        ((await db.execute(
          sql`select group_id as "groupId", parent_session_id as "parentSessionId", metadata from kortix.project_sessions where session_id = ${bound} limit 1`,
        )) as unknown as Array<{ groupId: string | null; parentSessionId: string | null; metadata: unknown }>)[0] ?? {
          groupId: null,
          parentSessionId: null,
          metadata: null,
        },
      )
    : null;
  for (const row of rows) {
    const folder = sessionGroupDriveFolder(row.groupId);
    if (!folder) continue;
    all.add(folder);
    if (bound && row.groupId !== own) continue;
    if (canSeeGroup(row, members.get(row.groupId) ?? [], viewer)) visible.add(folder);
  }
  return { all, visible };
}
