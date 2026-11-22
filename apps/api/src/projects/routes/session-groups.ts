/**
 * Session groups (`session_groups` flag): a project's shared folders of
 * sessions (`lib/session-groups.ts`). Every route answers 403
 * `feature_disabled` while the flag is off, after the project gate.
 *
 * Reading the groups needs what reading the session list needs: `read`
 * project access and `project.session.read`. Creating, renaming, reordering
 * and deleting a group, and filing a session, need `session` access, like a
 * session's labels: any member who works in the project organizes it for
 * everyone. A session is filed only by someone who may see it; to anyone else
 * it is 404.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  OkResponseSchema,
  SessionGroupAssignInputSchema,
  SessionGroupAssignmentSchema,
  SessionGroupCreateInputSchema,
  SessionGroupListSchema,
  SessionGroupOrderInputSchema,
  SessionGroupSchema,
  SessionGroupSharingInputSchema,
  SessionGroupUpdateInputSchema,
  SpaceTabsInputSchema,
  type SessionGroup,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { makeSessionGroupFolder } from '../../drives/space-folders';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession } from '../lib/http-session-access';
import {
  createSessionGroup,
  deleteSessionGroup,
  findSessionGroup,
  listSessionGroups,
  updateSessionGroup,
  reorderSessionGroups,
  setSessionGroup,
  setSessionGroupSharing,
  sessionGroupActivity,
  normalizeSessionGroupIcon,
  setSessionGroupTabs,
  type SessionGroupRow,
} from '../lib/session-groups';
import { serializeTabs } from '../lib/project-spaces';
import { canManageGroup, canSeeGroup, groupMemberAddedAt, groupMemberIds, type GroupViewer } from '../../shared/session-group-access';
import { groupViewerFor } from '../lib/session-group-viewer';
import { resolveUserIdentities, type UserIdentity } from '../lib/user-identity';
import { accountMemberRolesAmong } from '../../iam/membership-read';
import { workspaceIdParam } from '../../shared/route-params';

const projectParams = z.object({ workspaceId: z.string() });
const groupParams = projectParams.extend({ groupId: z.string() });
const sessionParams = projectParams.extend({ sessionId: z.string().min(1).max(128) });

const GROUP_NOT_FOUND = { error: 'No such session group in this workspace.', code: 'group_not_found' } as const;
const NAME_TAKEN = { error: 'Another group in this workspace already has that name.', code: 'group_name_taken' } as const;
const INVALID_ICON = {
  error: 'The icon must be one emoji, or a glyph from the icon picker in a preset colour or #rrggbb.',
  code: 'invalid_icon',
} as const;

type Profiles = {
  identities: Map<string, UserIdentity>;
  roles: Map<string, 'owner' | 'admin' | 'member'>;
  addedAt: Map<string, Map<string, Date>>;
};

/** The people of each group (creator, then members): profiles, workspace roles and when each was added, in three reads for all of them. */
async function profilesOf(groups: ReadonlyArray<readonly [SessionGroupRow, readonly string[]]>): Promise<Profiles> {
  const ids = [...new Set(groups.flatMap(([row, memberIds]) => [row.createdBy, ...memberIds]).filter((id): id is string => !!id))];
  const accountId = groups[0]?.[0].accountId;
  const [identities, rows, addedAt] = await Promise.all([
    resolveUserIdentities(ids),
    accountId && ids.length ? accountMemberRolesAmong(accountId, ids.filter(isUuid)) : Promise.resolve([]),
    groupMemberAddedAt(groups.map(([row]) => row.groupId)),
  ]);
  const roles: Profiles['roles'] = new Map();
  for (const row of rows) roles.set(row.userId, row.accountRole === 'owner' || row.accountRole === 'admin' ? row.accountRole : 'member');
  return { identities, roles, addedAt };
}

function serializeGroup(row: SessionGroupRow, memberIds: readonly string[], viewer: GroupViewer, profiles: Profiles): SessionGroup {
  const peopleIds = [row.createdBy, ...memberIds.filter((id) => id !== row.createdBy)].filter((id): id is string => !!id);
  return {
    people: peopleIds.map((id) => {
      const profile = profiles.identities.get(id);
      return {
        user_id: id,
        name: profile?.displayName ?? null,
        email: profile?.email ?? null,
        avatar_url: profile?.avatarUrl ?? null,
        is_creator: id === row.createdBy,
        workspace_role: profiles.roles.get(id) ?? null,
        added_at: id === row.createdBy ? null : (profiles.addedAt.get(row.groupId)?.get(id)?.toISOString() ?? null),
      };
    }),
    group_id: row.groupId,
    name: row.name,
    description: row.description,
    icon: normalizeSessionGroupIcon(row.icon),
    visibility: row.visibility === 'project' ? 'project' : 'private',
    member_ids: [...memberIds],
    tabs: serializeTabs(row.tabs),
    can_manage: canManageGroup(row, viewer),
    position: row.position,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** The project and the `session_groups` flag, at the access `need`: the gate of every route here. */
async function loadGroupsProject(c: Context<AppEnv>, need: 'read' | 'session') {
  const projectId = workspaceIdParam(c)!;
  const loaded = await loadProjectForUser(c, projectId, need);
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (need === 'read') {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  }
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'session_groups');
  if (gate) return gate;
  return loaded;
}

const SHARE_FORBIDDEN = {
  error: 'A space shares the sessions in it. Only the owner of a session that is not shared with the whole workspace can move it.',
  code: 'group_share_forbidden',
} as const;
const FORBIDDEN_MANAGE = {
  error: 'Only the person who created this space can change who sees it or delete it.',
  code: 'group_manage_forbidden',
} as const;
/** Sharing and deleting a space are a person's decisions: a session-bound credential is refused. */
const SESSION_BOUND_CALLER = {
  error: 'A person shares or deletes a space, on its page. A session cannot.',
  code: 'session_bound_caller',
} as const;

/** The groups this person sees, in order, with each one's members. */
async function visibleGroups(projectId: string, viewer: GroupViewer) {
  const rows = await listSessionGroups(projectId);
  const members = await groupMemberIds(rows.map((row) => row.groupId));
  const visible = rows.filter((row) => canSeeGroup(row, members.get(row.groupId) ?? [], viewer));
  return { rows: visible, members };
}

/**
 * One group the caller sees (404 `group_not_found` otherwise, so a private
 * group's id says nothing), and with `manage` one they may share or delete
 * (403 `group_manage_forbidden`).
 */
async function loadGroup(
  c: Context<AppEnv>,
  loaded: Exclude<Awaited<ReturnType<typeof loadGroupsProject>>, Response>,
  need: 'see' | 'manage',
) {
  const groupId = c.req.param('groupId')!;
  if (!isUuid(groupId)) return c.json(GROUP_NOT_FOUND, 404);
  const viewer = await groupViewerFor(loaded.userId, loaded.row.accountId);
  const group = await findSessionGroup(loaded.row.projectId, groupId);
  const memberIds = group ? ((await groupMemberIds([group.groupId])).get(group.groupId) ?? []) : [];
  if (!group || !canSeeGroup(group, memberIds, viewer)) return c.json(GROUP_NOT_FOUND, 404);
  if (need === 'manage' && !canManageGroup(group, viewer)) return c.json(FORBIDDEN_MANAGE, 403);
  return { group, memberIds, viewer };
}

/** Registers every `/session-groups` route and `PUT /sessions/:id/group`, in dispatch order. */
export function registerSessionGroupsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/session-groups',
      tags: ['sessions'],
      summary: 'List the session groups (Spaces) the caller sees',
      description: 'The groups the caller sees, in the project order: `project` ones, ones they created, ones shared with them (all of them under account session oversight). List a group’s sessions with `GET /sessions?group=<group_id>`.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(SessionGroupListSchema, 'The groups, in order'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'read');
      if (loaded instanceof Response) return loaded;
      const viewer = await groupViewerFor(loaded.userId, loaded.row.accountId);
      const { rows, members } = await visibleGroups(loaded.row.projectId, viewer);
      const activity = await sessionGroupActivity(loaded.row.projectId, rows.map((row) => row.groupId));
      const profiles = await profilesOf(rows.map((row) => [row, members.get(row.groupId) ?? []] as const));
      return c.json(
        {
          groups: rows.map((row) => {
            const seen = activity.get(row.groupId);
            return {
              ...serializeGroup(row, members.get(row.groupId) ?? [], viewer, profiles),
              session_count: seen?.sessionCount ?? 0,
              last_activity_at: seen?.lastActivityAt?.toISOString() ?? null,
            };
          }),
        },
        200,
      );
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/session-groups',
      tags: ['sessions'],
      summary: 'Create a session group',
      description: 'The new group is private to its creator (`visibility: private`, no members) and goes last in the order. A name another group of the project has, in any case, is refused (409 `group_name_taken`); a project holds at most 50 groups (409 `group_limit`).',
      ...auth,
      request: {
        params: projectParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupCreateInputSchema } } },
      },
      responses: { 201: json(SessionGroupSchema, 'The new group'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const body = c.req.valid('json');
      const icon = body.icon === undefined ? undefined : normalizeSessionGroupIcon(body.icon);
      if (icon === null) return c.json(INVALID_ICON, 400);
      const result = await createSessionGroup({
        accountId: loaded.row.accountId,
        projectId: loaded.row.projectId,
        name: body.name,
        description: body.description ?? null,
        icon,
        createdBy: loaded.userId,
      });
      if (!result.ok) {
        return result.code === 'group_limit'
          ? c.json({ error: 'This project already has 50 session groups.', code: 'group_limit' }, 409)
          : c.json(NAME_TAKEN, 409);
      }
      // Its Files folder, best effort and off the response path.
      void makeSessionGroupFolder(loaded.row.accountId, loaded.row.projectId, result.group.groupId);
      return c.json(
        serializeGroup(result.group, [], await groupViewerFor(loaded.userId, loaded.row.accountId), await profilesOf([[result.group, []]])),
        201,
      );
    },
  );

  // Before `/{groupId}`: `order` is not a group id.
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/session-groups/order',
      tags: ['sessions'],
      summary: 'Reorder the session groups of a project',
      description: 'Send every group id the caller sees once, in the new order; a group they do not see keeps its place. A list that is out of date (a group missing, added or foreign) changes nothing and answers 409 `group_order_stale`: read the list again.',
      ...auth,
      request: {
        params: projectParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupOrderInputSchema } } },
      },
      responses: { 200: json(SessionGroupListSchema, 'The groups, in the new order'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const viewer = await groupViewerFor(loaded.userId, loaded.row.accountId);
      const { rows } = await visibleGroups(loaded.row.projectId, viewer);
      const seen = new Set(rows.map((row) => row.groupId));
      const result = await reorderSessionGroups(loaded.row.projectId, c.req.valid('json').group_ids, (id) => seen.has(id));
      if (!result.ok) {
        return c.json({ error: 'The group list changed. Read it again and resend the order.', code: 'group_order_stale' }, 409);
      }
      const after = await visibleGroups(loaded.row.projectId, viewer);
      const profiles = await profilesOf(after.rows.map((row) => [row, after.members.get(row.groupId) ?? []] as const));
      return c.json({ groups: after.rows.map((row) => serializeGroup(row, after.members.get(row.groupId) ?? [], viewer, profiles)) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/session-groups/{groupId}',
      tags: ['sessions'],
      summary: 'Rename a session group, or change its description or icon',
      ...auth,
      request: {
        params: groupParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupUpdateInputSchema } } },
      },
      responses: { 200: json(SessionGroupSchema, 'The changed group'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const found = await loadGroup(c, loaded, 'see');
      if (found instanceof Response) return found;
      const body = c.req.valid('json');
      const icon = body.icon == null ? body.icon : normalizeSessionGroupIcon(body.icon);
      if (body.icon != null && icon === null) return c.json(INVALID_ICON, 400);
      const result = await updateSessionGroup(loaded.row.projectId, found.group.groupId, { ...body, icon });
      if (!result.ok) return result.code === 'group_not_found' ? c.json(GROUP_NOT_FOUND, 404) : c.json(NAME_TAKEN, 409);
      return c.json(serializeGroup(result.group, found.memberIds, found.viewer, await profilesOf([[result.group, found.memberIds]])), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/session-groups/{groupId}',
      tags: ['sessions'],
      summary: 'Delete a session group',
      description: 'Its creator (or an owner or admin under account session oversight) only: 403 `group_manage_forbidden` for anyone else who sees it. Its sessions stay and are in no group, back to their own sharing; the groups after it move up one place.',
      ...auth,
      request: { params: groupParams },
      responses: { 200: json(OkResponseSchema, 'Deleted'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const found = await loadGroup(c, loaded, 'manage');
      if (found instanceof Response) return found;
      if (!(await deleteSessionGroup(loaded.row.projectId, found.group.groupId))) return c.json(GROUP_NOT_FOUND, 404);
      return c.json({ ok: true as const }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/session-groups/{groupId}/sharing',
      tags: ['sessions'],
      summary: 'Change who sees a session group (Space)',
      description:
        '`private` with no `member_ids`: only its creator. `private` with ids: its creator and those people (each a member of the account: 400 `not_a_member` otherwise). `project`: everyone in the project. Whoever sees a group sees every session in it and its Files folder. Its creator (or an owner or admin under account session oversight) only: 403 `group_manage_forbidden`; a session-bound credential: 403 `session_bound_caller`.',
      ...auth,
      request: {
        params: groupParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupSharingInputSchema } } },
      },
      responses: { 200: json(SessionGroupSchema, 'The group with its new sharing'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const found = await loadGroup(c, loaded, 'manage');
      if (found instanceof Response) return found;
      const input = c.req.valid('json');
      const result = await setSessionGroupSharing({
        projectId: loaded.row.projectId,
        accountId: loaded.row.accountId,
        groupId: found.group.groupId,
        visibility: input.visibility,
        memberIds: input.member_ids,
        addedBy: loaded.userId,
      });
      if (!result.ok) {
        return result.code === 'not_a_member'
          ? c.json({ error: 'Share a space only with members of this workspace.', code: 'not_a_member' }, 400)
          : c.json(GROUP_NOT_FOUND, 404);
      }
      return c.json(serializeGroup(result.group, result.memberIds, found.viewer, await profilesOf([[result.group, result.memberIds]])), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/session-groups/{groupId}/tabs',
      tags: ['sessions'],
      summary: 'Replace the tabs of a session group (Space)',
      description:
        'The whole ordered list after Sessions (at most 20; the kinds and rules of a channel tab, `SpaceTabSchema`). Anyone who sees the group. A link tab’s `embeddable` is the server’s.',
      ...auth,
      request: {
        params: groupParams,
        body: { required: true, content: { 'application/json': { schema: SpaceTabsInputSchema } } },
      },
      responses: { 200: json(SessionGroupSchema, 'The group with its new tabs'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const found = await loadGroup(c, loaded, 'see');
      if (found instanceof Response) return found;
      const updated = await setSessionGroupTabs(loaded.row.projectId, found.group, c.req.valid('json').tabs);
      if (!updated) return c.json(GROUP_NOT_FOUND, 404);
      return c.json(serializeGroup(updated, found.memberIds, found.viewer, await profilesOf([[updated, found.memberIds]])), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/sessions/{sessionId}/group',
      tags: ['sessions'],
      summary: 'File a session into a session group',
      description: '`group_id` files the session into that group of its project (one the caller sees: 404 `group_not_found` otherwise); `null` takes it out of its group. A group shares the sessions in it, so only the session’s owner may file a session that is not visible to the whole project (403 `group_share_forbidden`). The session keeps its `updated_at`, so it keeps its place in the list. A session another session started stays with its parent: 400 `group_child_session`.',
      ...auth,
      request: {
        params: sessionParams,
        body: { required: true, content: { 'application/json': { schema: SessionGroupAssignInputSchema } } },
      },
      responses: { 200: json(SessionGroupAssignmentSchema, 'The session and its group'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const loaded = await loadGroupsProject(c, 'session');
      if (loaded instanceof Response) return loaded;
      const sessionId = c.req.param('sessionId')!;
      const guard = await guardSession(c, loaded, sessionId, 'read');
      if (!guard.ok) return c.json({ error: guard.error }, guard.status);
      const target = c.req.valid('json').group_id;
      const session = guard.session.row;
      const owner = session.createdBy === loaded.userId;
      // A group shares what is in it: filing someone else's private or restricted session would share it again.
      if (!owner && session.visibility !== 'project' && (target !== null || session.groupId !== null)) {
        return c.json(SHARE_FORBIDDEN, 403);
      }
      if (target !== null) {
        const viewer = await groupViewerFor(loaded.userId, loaded.row.accountId);
        const group = isUuid(target) ? await findSessionGroup(loaded.row.projectId, target) : null;
        const memberIds = group ? ((await groupMemberIds([group.groupId])).get(group.groupId) ?? []) : [];
        if (!group || !canSeeGroup(group, memberIds, viewer)) return c.json(GROUP_NOT_FOUND, 404);
      }
      const result = await setSessionGroup(loaded.row.projectId, sessionId, target);
      if (!result.ok) {
        if (result.code === 'child_session') {
          return c.json(
            { error: 'A session another session started stays with its parent. File the parent instead.', code: 'group_child_session' },
            400,
          );
        }
        return result.code === 'group_not_found' ? c.json(GROUP_NOT_FOUND, 404) : c.json({ error: 'Not found' }, 404);
      }
      return c.json({ session_id: sessionId, group_id: result.groupId }, 200);
    },
  );
}
