// Session groups — `/v1/projects/:id/session-groups` (apps/api/src/projects/routes/session-groups.ts).
// A group (product word "Space") is a named folder of the project's sessions
// that every member sees, in one shared order. Every session of a group is told
// its name and description at turn start and mounts its Files folder. A session is in at most one group
// (`ProjectSession.group_id`); list a group's sessions with
// `listProjectSessionsPage(projectId, { group })`. Every route answers 403
// `feature_disabled` while the project's `session_groups` flag is off.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { ProjectSpaceTab } from './spaces';

/**
 * A session group. Same fields as the API's `SessionGroup`.
 *
 * @deprecated Use `WorkspaceSessionGroup`. Kept permanently.
 */
export interface ProjectSessionGroup {
  group_id: string;
  /** 1–80 characters, unique in the project in any case. */
  name: string;
  /** What the group is for, at most 2000 characters; null when none was given. Absent on older APIs. */
  description?: string | null;
  /**
   * An emoji XOR a glyph from the project icon catalogue. Null (or absent, on
   * older APIs): draw `suggestSpaceIcon(name)` from `@kortix/shared`.
   */
  icon?: { emoji: string } | { glyph: { name: string; color: string } } | null;
  /**
   * `private` (the default): its creator and `member_ids` see it and every
   * session in it. `project`: everyone in the project does. Absent on older APIs.
   */
  visibility?: WorkspaceSessionGroupVisibility;
  /** The people a `private` group is shared with (its creator not listed). Absent on older APIs. */
  member_ids?: string[];
  /** Its creator, then `member_ids`, each with a profile; every viewer of the group can read it. Absent on older APIs. */
  people?: Array<{
    user_id: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
    is_creator: boolean;
    /** Their role in the workspace; null when they left it. Absent on older APIs. */
    workspace_role?: 'owner' | 'admin' | 'member' | null;
    /** When they were added to the group; null for its creator. Absent on older APIs. */
    added_at?: string | null;
  }>;
  /** The tabs after Sessions, in order: a channel's tab shape. Absent on older APIs. */
  tabs?: ProjectSpaceTab[];
  /** The caller may change its sharing and delete it. Absent on older APIs. */
  can_manage?: boolean;
  /** 0-based place in the project's order. */
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** In a list: the group's top-level sessions the caller can open. Absent on older APIs and on single-group responses. */
  session_count?: number;
  /** In a list: when the newest of those sessions last changed; null with none. Absent on older APIs and on single-group responses. */
  last_activity_at?: string | null;
}

/** The workspace name of {@link ProjectSessionGroup}: the same type. */
export type WorkspaceSessionGroup = ProjectSessionGroup;

/** Who sees a session group: its creator and members (`private`) or the whole project. */
export type WorkspaceSessionGroupVisibility = 'private' | 'project';

/** {@link setWorkspaceSessionGroupSharing}: `private` with no ids is "Only me", with ids "Specific people"; `project` is everyone. */
export interface WorkspaceSessionGroupSharingInput {
  visibility: WorkspaceSessionGroupVisibility;
  /** Members of the account; ignored (and cleared) for `project`. */
  member_ids?: string[];
}

/** @deprecated Use `CreateWorkspaceSessionGroupInput`. Kept permanently. */
export interface CreateProjectSessionGroupInput {
  /** 1–80 characters after trimming. */
  name: string;
  /** What the group is for, at most 2000 characters after trimming. */
  description?: string | null;
  /** Absent: the API gives the icon the name suggests. A bad value rejects with 400 `invalid_icon`. */
  icon?: { emoji: string } | { glyph: { name: string; color: string } };
}

/** The workspace name of {@link CreateProjectSessionGroupInput}: the same type. */
export type CreateWorkspaceSessionGroupInput = CreateProjectSessionGroupInput;

/**
 * A session and the group it is filed in (null: none).
 *
 * @deprecated Use `WorkspaceSessionGroupAssignment`. Kept permanently.
 */
export interface ProjectSessionGroupAssignment {
  session_id: string;
  group_id: string | null;
}

/** The workspace name of {@link ProjectSessionGroupAssignment}: the same type. */
export type WorkspaceSessionGroupAssignment = ProjectSessionGroupAssignment;

/** The project's groups, in order. A background read: a failure reaches the caller's query state, not the host error handler. */
export async function listWorkspaceSessionGroups(projectId: string): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.get<{ groups: ProjectSessionGroup[] }>(`/workspaces/${projectId}/session-groups`, { showErrors: false }),
  );
  return body.groups;
}

/** @deprecated Use `listWorkspaceSessionGroups`. Kept permanently. */
export const listProjectSessionGroups = listWorkspaceSessionGroups;

/**
 * Create a group, last in the order. A name another group of the project has
 * (any case) rejects with an `ApiError` 409 `group_name_taken`; a project with
 * 50 groups rejects with 409 `group_limit`. The caller shows the error, so it
 * never reaches the host error handler.
 */
export async function createWorkspaceSessionGroup(projectId: string, input: CreateProjectSessionGroupInput) {
  return unwrap(
    await backendApi.post<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups`, input, { showErrors: false }),
  );
}

/** @deprecated Use `createWorkspaceSessionGroup`. Kept permanently. */
export const createProjectSessionGroup = createWorkspaceSessionGroup;

/** Rename a group. A taken name rejects with 409 `group_name_taken`; an unknown group with 404 `group_not_found`. */
export async function renameWorkspaceSessionGroup(projectId: string, groupId: string, name: string) {
  return unwrap(
    await backendApi.patch<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups/${groupId}`, { name }, { showErrors: false }),
  );
}

/** @deprecated Use `renameWorkspaceSessionGroup`. Kept permanently. */
export const renameProjectSessionGroup = renameWorkspaceSessionGroup;

/** Delete a group. Its sessions stay, in no group; the groups after it move up one place. */
export async function deleteWorkspaceSessionGroup(projectId: string, groupId: string): Promise<void> {
  unwrap(await backendApi.delete<{ ok: true }>(`/workspaces/${projectId}/session-groups/${groupId}`, { showErrors: false }));
}

/** The fields {@link updateWorkspaceSessionGroup} changes; at least one. */
export interface UpdateWorkspaceSessionGroupInput {
  /** 1–80 characters after trimming. */
  name?: string;
  /** At most 2000 characters after trimming; `null` or empty clears it. */
  description?: string | null;
  /** The new icon; `null` takes it off. A bad value rejects with 400 `invalid_icon`. */
  icon?: { emoji: string } | { glyph: { name: string; color: string } } | null;
}

/**
 * Rename a group, change its description or its icon; only the fields given are
 * sent. A taken name rejects with 409 `group_name_taken`; an unknown group
 * with 404 `group_not_found`.
 */
export async function updateWorkspaceSessionGroup(projectId: string, groupId: string, input: UpdateWorkspaceSessionGroupInput) {
  return unwrap(
    await backendApi.patch<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups/${groupId}`, input, { showErrors: false }),
  );
}

/**
 * Change who sees a group; whoever sees it sees every session in it. Its
 * creator only (or an owner or admin under account session oversight): 403
 * `group_manage_forbidden` otherwise; a person outside the account in
 * `member_ids` rejects with 400 `not_a_member`.
 */
export async function setWorkspaceSessionGroupSharing(
  projectId: string,
  groupId: string,
  input: WorkspaceSessionGroupSharingInput,
) {
  return unwrap(
    await backendApi.put<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups/${groupId}/sharing`, input, { showErrors: false }),
  );
}

/** Replace a group's tabs (the whole ordered list after Sessions, at most 20). Anyone who sees the group. */
export async function setWorkspaceSessionGroupTabs(projectId: string, groupId: string, tabs: ProjectSpaceTab[]) {
  return unwrap(
    await backendApi.put<ProjectSessionGroup>(`/workspaces/${projectId}/session-groups/${groupId}/tabs`, { tabs }, { showErrors: false }),
  );
}

/** @deprecated Use `deleteWorkspaceSessionGroup`. Kept permanently. */
export const deleteProjectSessionGroup = deleteWorkspaceSessionGroup;

/**
 * Put the project's groups in this order: every group id, each once. A list
 * that is out of date (a group missing, added or foreign) changes nothing and
 * rejects with 409 `group_order_stale`: read the list again. Resolves the
 * groups in the new order.
 */
export async function reorderWorkspaceSessionGroups(projectId: string, groupIds: readonly string[]): Promise<ProjectSessionGroup[]> {
  const body = unwrap(
    await backendApi.put<{ groups: ProjectSessionGroup[] }>(
      `/workspaces/${projectId}/session-groups/order`,
      { group_ids: groupIds },
      { showErrors: false },
    ),
  );
  return body.groups;
}

/** @deprecated Use `reorderWorkspaceSessionGroups`. Kept permanently. */
export const reorderProjectSessionGroups = reorderWorkspaceSessionGroups;

/**
 * File a session into a group of its project, or take it out of its group
 * (`null`). The session keeps its `updated_at`, so it keeps its place in the
 * list. An unknown group rejects with 404 `group_not_found`; a session the
 * caller cannot see with 404.
 */
export async function setWorkspaceSessionGroup(projectId: string, sessionId: string, groupId: string | null) {
  return unwrap(
    await backendApi.put<ProjectSessionGroupAssignment>(
      `/workspaces/${projectId}/sessions/${sessionId}/group`,
      { group_id: groupId },
      { showErrors: false },
    ),
  );
}

/** @deprecated Use `setWorkspaceSessionGroup`. Kept permanently. */
export const setProjectSessionGroup = setWorkspaceSessionGroup;
