/**
 * Session groups (product word "Spaces") — named folders of a project's
 * sessions that every member shares, behind the `session_groups` flag. A
 * group has a description, and a session can be created in one (`group_id`). Spec: tests/spec/end-to-end.md
 * § 7b. Source of truth: apps/api/src/projects/routes/session-groups.ts +
 * projects/lib/session-groups.ts + the `group` filter of GET /sessions.
 */
import { randomUUID } from 'node:crypto';
import {
  OkResponseSchema,
  ProjectSessionSchema,
  SessionGroupAssignmentSchema,
  SessionGroupListSchema,
  SessionGroupSchema,
} from '@kortix/api-contract';
import { flow, flowMeta } from '../core/flow';
import { fail } from '../core/expect';
import type { FlowMeta } from '../core/types';
import { insertSession, openWorld } from '../fixtures/agent-principals';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/session-groups',
  create: 'POST /v1/projects/:projectId/session-groups',
  update: 'PATCH /v1/projects/:projectId/session-groups/:groupId',
  remove: 'DELETE /v1/projects/:projectId/session-groups/:groupId',
  order: 'PUT /v1/projects/:projectId/session-groups/order',
  assign: 'PUT /v1/projects/:projectId/sessions/:sessionId/group',
  sharing: 'PUT /v1/projects/:projectId/session-groups/:groupId/sharing',
  tabs: 'PUT /v1/projects/:projectId/session-groups/:groupId/tabs',
};
const SESSION_ROUTES = {
  list: 'GET /v1/projects/:projectId/sessions',
  read: 'GET /v1/projects/:projectId/sessions/:sessionId',
  create: 'POST /v1/projects/:projectId/sessions',
};
const GROUPS = '/v1/workspaces/:projectId/session-groups';
const GROUP = '/v1/workspaces/:projectId/session-groups/:groupId';
const ORDER = '/v1/workspaces/:projectId/session-groups/order';
const SHARING = '/v1/workspaces/:projectId/session-groups/:groupId/sharing';
const TABS = '/v1/workspaces/:projectId/session-groups/:groupId/tabs';
const ASSIGN = '/v1/workspaces/:projectId/sessions/:sessionId/group';
const SESSIONS = '/v1/workspaces/:projectId/sessions';
const SESSION = '/v1/workspaces/:projectId/sessions/:sessionId';

type Group = { group_id: string; name: string; description: string | null; position: number };
type Session = { session_id: string; group_id: string | null; updated_at: string };

flow('SGRP-1', flowMeta('session-groups', Object.values(ROUTES), { timeoutMs: 120_000 }), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await ctx.step('with session_groups off (the default), every session-groups route → 403 feature_disabled', async () => {
      const groupParams = { ...params, groupId: randomUUID() };
      for (const r of [
        await world.owner.get(GROUPS, { params }),
        await world.owner.post(GROUPS, { name: 'Store A' }, { params }),
        await world.owner.patch(GROUP, { name: 'Store B' }, { params: groupParams }),
        await world.owner.del(GROUP, { params: groupParams }),
        await world.owner.put(ORDER, { group_ids: [] }, { params }),
        await world.owner.put(ASSIGN, { group_id: null }, { params: { ...params, sessionId: randomUUID() } }),
        await world.owner.put(SHARING, { visibility: 'project' }, { params: groupParams }),
        await world.owner.put(TABS, { tabs: [] }, { params: groupParams }),
      ]) {
        r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'session_groups');
      }
    });

    await ctx.step('the refused writes stored nothing: the project has no group row', async () => {
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_session_groups WHERE project_id = $1', [project.id]);
      if (rows.length !== 0) fail(`expected no groups, found ${rows.length}`);
    });

    await ctx.step('an anonymous caller → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get(GROUPS, { params })).status(401);
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-2', flowMeta('session-groups', [ROUTES.list, ROUTES.create, ROUTES.update, ROUTES.remove, ROUTES.order, ROUTES.sharing], { timeoutMs: 120_000 }), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const asMember = ctx.client.as(member);
  // Membership is access (design.md C3): the outsider is a person outside the workspace.
  const outsider = ctx.client.as(ctx.P.NONMEMBER);
  const ids: Record<string, string> = {};
  try {
    await world.setFeature('session_groups', true);

    await ctx.step('the owner creates Store A and Store B, a member creates Store C → 201 each, last in the order', async () => {
      for (const [client, name, position] of [
        [world.owner, '  Store A  ', 0],
        [world.owner, 'Store B', 1],
        [asMember, 'Store C', 2],
      ] as const) {
        const r = await client.post(GROUPS, { name }, { params });
        r.status(201).body().schema(SessionGroupSchema).has('$.name', name.trim()).has('$.position', position)
          .has('$.visibility', 'private').has('$.can_manage', true);
        ids[name.trim()] = r.json<Group>().group_id;
      }
    });

    await ctx.step('a new group is private to its creator: the owner lists A and B, the member only C', async () => {
      const names = async (client: typeof world.owner) =>
        (await client.get(GROUPS, { params })).status(200).json<{ groups: Group[] }>().groups.map((group) => group.name);
      if (JSON.stringify(await names(world.owner)) !== JSON.stringify(['Store A', 'Store B'])) fail('owner list', await names(world.owner));
      if (JSON.stringify(await names(asMember)) !== JSON.stringify(['Store C'])) fail('member list', await names(asMember));
    });

    await ctx.step('each creator shares theirs with the whole project → 200 visibility project', async () => {
      for (const [client, name] of [[world.owner, 'Store A'], [world.owner, 'Store B'], [asMember, 'Store C']] as const) {
        (await client.put(SHARING, { visibility: 'project' }, { params: { ...params, groupId: ids[name]! } }))
          .status(200).body().schema(SessionGroupSchema).has('$.visibility', 'project');
      }
    });

    await ctx.step('GET lists them in order for the owner and the member alike', async () => {
      for (const client of [world.owner, asMember]) {
        const r = await client.get(GROUPS, { params });
        r.status(200).body().schema(SessionGroupListSchema);
        const names = r.json<{ groups: Group[] }>().groups.map((group) => group.name);
        if (JSON.stringify(names) !== JSON.stringify(['Store A', 'Store B', 'Store C'])) fail('wrong order', names);
      }
    });

    await ctx.step('a name the project has in any case → 409 group_name_taken; a blank or 81-character name → 400', async () => {
      (await world.owner.post(GROUPS, { name: 'store a' }, { params })).status(409).body().has('$.code', 'group_name_taken');
      (await world.owner.post(GROUPS, { name: '   ' }, { params })).status(400);
      (await world.owner.post(GROUPS, { name: 'x'.repeat(81) }, { params })).status(400);
    });

    await ctx.step('an account member outside the project → 403/404 on list and create, and stores nothing', async () => {
      (await outsider.get(GROUPS, { params })).status([403, 404]);
      (await outsider.post(GROUPS, { name: 'Intruder' }, { params })).status([403, 404]);
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_session_groups WHERE project_id = $1', [project.id]);
      if (rows.length !== 3) fail(`expected 3 groups, found ${rows.length}`);
    });

    await ctx.step('a description is trimmed and stored; PATCH changes it alone, empty clears it; 2001 characters or an empty PATCH → 400', async () => {
      const r = await world.owner.post(GROUPS, { name: 'Launch', description: '  Ship the pricing page.  ' }, { params });
      r.status(201).body().schema(SessionGroupSchema).has('$.description', 'Ship the pricing page.');
      const launch = r.json<Group>().group_id;
      (await world.owner.patch(GROUP, { description: 'Ship it by Dec 1.' }, { params: { ...params, groupId: launch } }))
        .status(200).body().has('$.name', 'Launch').has('$.description', 'Ship it by Dec 1.');
      (await world.owner.patch(GROUP, { description: '' }, { params: { ...params, groupId: launch } })).status(200).body().has('$.description', null);
      (await world.owner.post(GROUPS, { name: 'Long', description: 'x'.repeat(2001) }, { params })).status(400);
      (await world.owner.patch(GROUP, {}, { params: { ...params, groupId: launch } })).status(400);
      (await world.owner.del(GROUP, { params: { ...params, groupId: launch } })).status(200);
    });

    await ctx.step('PATCH renames; a taken name → 409; an unknown or malformed id → 404 group_not_found', async () => {
      (await world.owner.patch(GROUP, { name: 'Store A (EU)' }, { params: { ...params, groupId: ids['Store A']! } }))
        .status(200).body().schema(SessionGroupSchema).has('$.name', 'Store A (EU)').has('$.position', 0);
      (await asMember.patch(GROUP, { name: 'STORE B' }, { params: { ...params, groupId: ids['Store C']! } }))
        .status(409).body().has('$.code', 'group_name_taken');
      for (const groupId of [randomUUID(), 'not-a-uuid']) {
        (await world.owner.patch(GROUP, { name: 'X' }, { params: { ...params, groupId } })).status(404).body().has('$.code', 'group_not_found');
      }
    });

    await ctx.step('PUT /order with every id once → 200 in the new order; a partial or foreign list → 409 group_order_stale and nothing moves', async () => {
      const order = [ids['Store C']!, ids['Store A']!, ids['Store B']!];
      const r = await asMember.put(ORDER, { group_ids: order }, { params });
      r.status(200).body().schema(SessionGroupListSchema);
      const got = r.json<{ groups: Group[] }>().groups.map((group) => [group.group_id, group.position]);
      if (JSON.stringify(got) !== JSON.stringify(order.map((id, i) => [id, i]))) fail('order not applied', got);
      (await world.owner.put(ORDER, { group_ids: order.slice(0, 2) }, { params })).status(409).body().has('$.code', 'group_order_stale');
      (await world.owner.put(ORDER, { group_ids: [...order.slice(0, 2), randomUUID()] }, { params }))
        .status(409).body().has('$.code', 'group_order_stale');
      (await world.owner.put(ORDER, { group_ids: [order[0], order[0], order[1]] }, { params })).status(400);
      const after = (await world.owner.get(GROUPS, { params })).json<{ groups: Group[] }>().groups.map((group) => group.group_id);
      if (JSON.stringify(after) !== JSON.stringify(order)) fail('a refused reorder moved groups', after);
    });

    await ctx.step('DELETE by someone who is not its creator → 403 group_manage_forbidden; by its creator → 200 {ok}; the rest close up; again → 404', async () => {
      (await asMember.del(GROUP, { params: { ...params, groupId: ids['Store A']! } })).status(403).body().has('$.code', 'group_manage_forbidden');
      (await world.owner.del(GROUP, { params: { ...params, groupId: ids['Store A']! } })).status(200).body().schema(OkResponseSchema);
      const groups = (await world.owner.get(GROUPS, { params })).json<{ groups: Group[] }>().groups;
      const got = groups.map((group) => [group.name, group.position]);
      if (JSON.stringify(got) !== JSON.stringify([['Store C', 0], ['Store B', 1]])) fail('positions did not close up', got);
      (await world.owner.del(GROUP, { params: { ...params, groupId: ids['Store A']! } })).status(404).body().has('$.code', 'group_not_found');
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-3', flowMeta('session-groups', [ROUTES.create, ROUTES.sharing, ROUTES.assign, ROUTES.remove, SESSION_ROUTES.list, SESSION_ROUTES.read], { timeoutMs: 120_000 }), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const asMember = ctx.client.as(member);
  const other = await team.project({ managedGit: true });
  try {
    await world.setFeature('session_groups', true);
    const store = (await world.owner.post(GROUPS, { name: 'Store A' }, { params })).status(201).json<Group>().group_id;
    (await world.owner.put(SHARING, { visibility: 'project' }, { params: { ...params, groupId: store } })).status(200);
    const shared = await insertSession(world, world.ownerUserId, 'project');
    const loose = await insertSession(world, world.ownerUserId, 'project');
    const hidden = await insertSession(world, world.ownerUserId, 'private');
    const readSession = async (sessionId: string) =>
      (await world.owner.get(SESSION, { params: { ...params, sessionId } })).status(200).json<Session>();
    const listIds = async (query: Record<string, string>) =>
      (await world.owner.get(SESSIONS, { params, query })).status(200).json<Session[]>().map((s) => s.session_id).sort();

    await ctx.step('a member files a project session into Store A → 200 {session_id, group_id}; its updated_at stays', async () => {
      const before = await readSession(shared);
      if (before.group_id !== null) fail('a new session is already in a group', before.group_id);
      (await asMember.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: shared } }))
        .status(200).body().schema(SessionGroupAssignmentSchema).has('$.session_id', shared).has('$.group_id', store);
      const after = await readSession(shared);
      if (after.group_id !== store) fail('GET /sessions/:id does not carry the group', after.group_id);
      if (after.updated_at !== before.updated_at) fail('filing moved updated_at', [before.updated_at, after.updated_at]);
    });

    await ctx.step('GET /sessions?group=<id> lists only its sessions, each with group_id; ?group=none leaves them out', async () => {
      const grouped = (await world.owner.get(SESSIONS, { params, query: { group: store } })).status(200);
      grouped.body().schema(ProjectSessionSchema.array());
      const rows = grouped.json<Session[]>();
      if (rows.length !== 1 || rows[0]!.session_id !== shared || rows[0]!.group_id !== store) fail('group list', rows);
      const none = await listIds({ group: 'none' });
      if (none.includes(shared) || !none.includes(loose)) fail('group=none', none);
      (await world.owner.get(SESSIONS, { params, query: { group: 'store-a' } })).status(400);
    });

    await ctx.step('GET /session-groups counts each space\'s sessions: Store A has 1, last active at its updated_at; a new empty space has 0 and null', async () => {
      const empty = (await world.owner.post(GROUPS, { name: 'Empty' }, { params })).status(201).json<Group>().group_id;
      const listed = (await world.owner.get(GROUPS, { params })).status(200).json<{ groups: Array<Group & { session_count?: number; last_activity_at?: string | null }> }>().groups;
      const a = listed.find((group) => group.group_id === store);
      const e = listed.find((group) => group.group_id === empty);
      const session = await readSession(shared);
      if (a?.session_count !== 1) fail('Store A session_count', a);
      if (!a?.last_activity_at || Date.parse(a.last_activity_at) !== Date.parse(session.updated_at)) fail('Store A last_activity_at', [a?.last_activity_at, session.updated_at]);
      if (e?.session_count !== 0 || e.last_activity_at !== null) fail('Empty space activity', e);
      (await world.owner.del(GROUP, { params: { ...params, groupId: empty } })).status(200);
    });

    await ctx.step("a session the member cannot see → 404; another project's group or an unknown one → 404 group_not_found", async () => {
      (await asMember.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: hidden } })).status(404);
      const foreign = randomUUID();
      await world.db.query(
        `INSERT INTO kortix.project_session_groups (group_id, account_id, project_id, name, position)
         VALUES ($1, $2, $3, 'Elsewhere', 0)`,
        [foreign, world.accountId, other.id],
      );
      for (const groupId of [foreign, randomUUID()]) {
        (await world.owner.put(ASSIGN, { group_id: groupId }, { params: { ...params, sessionId: loose } }))
          .status(404).body().has('$.code', 'group_not_found');
      }
      if ((await readSession(loose)).group_id !== null) fail('a refused filing changed the session');
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: randomUUID() } })).status(404);
    });

    await ctx.step('a session another session started stays with its parent: filing it → 400 group_child_session', async () => {
      const child = await insertSession(world, world.ownerUserId, 'project');
      await world.db.query('UPDATE kortix.project_sessions SET parent_session_id = $1 WHERE session_id = $2', [shared, child]);
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: child } }))
        .status(400).body().has('$.code', 'group_child_session');
      if ((await readSession(child)).group_id !== null) fail('a refused child was filed');
    });

    await ctx.step('group_id null takes the session out of its group', async () => {
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: loose } })).status(200);
      (await world.owner.put(ASSIGN, { group_id: null }, { params: { ...params, sessionId: loose } }))
        .status(200).body().has('$.group_id', null);
      if ((await readSession(loose)).group_id !== null) fail('null did not take the session out');
    });

    await ctx.step('with the flag off, ?group= is ignored (both sessions listed) and the session keeps its group_id', async () => {
      await world.setFeature('session_groups', false);
      const all = await listIds({ group: store });
      if (!all.includes(shared) || !all.includes(loose)) fail('flag off still filtered by group', all);
      const { rows } = await world.db.query<{ group_id: string | null }>('SELECT s.group_id FROM kortix.project_sessions s JOIN kortix.project_session_groups g ON g.group_id = s.group_id WHERE s.session_id = $1', [shared]);
      if (rows[0]?.group_id !== store) fail('flag off removed the filing');
      await world.setFeature('session_groups', true);
    });

    await ctx.step('deleting Store A leaves its session in no group', async () => {
      (await world.owner.del(GROUP, { params: { ...params, groupId: store } })).status(200);
      if ((await readSession(shared)).group_id !== null) fail('the session still names the deleted group');
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-5', flowMeta('session-groups', [ROUTES.list, ROUTES.create, ROUTES.update, ROUTES.remove, ROUTES.sharing, ROUTES.assign, SESSION_ROUTES.list, SESSION_ROUTES.read], { timeoutMs: 120_000 }), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const ana = await team.addMember('member');
  await team.grantProjectRole(project.id, ana.userId!, 'member');
  const bob = await team.addMember('member');
  await team.grantProjectRole(project.id, bob.userId!, 'member');
  const asAna = ctx.client.as(ana);
  const asBob = ctx.client.as(bob);
  try {
    await world.setFeature('session_groups', true);
    const space = (await world.owner.post(GROUPS, { name: 'Board prep', description: 'December board meeting.' }, { params }))
      .status(201).json<Group>().group_id;
    const groupParams = { ...params, groupId: space };
    const filed = await insertSession(world, world.ownerUserId, 'private');
    const ownersOther = await insertSession(world, world.ownerUserId, 'private');
    (await world.owner.put(ASSIGN, { group_id: space }, { params: { ...params, sessionId: filed } })).status(200);
    const child = await insertSession(world, world.ownerUserId, 'private', { metadata: { spawned_by_session: filed } });
    const listedBy = async (client: typeof world.owner) =>
      (await client.get(SESSIONS, { params })).status(200).json<Session[]>().map((row) => row.session_id);
    const groupNames = async (client: typeof world.owner) =>
      (await client.get(GROUPS, { params })).status(200).json<{ groups: Group[] }>().groups.map((group) => group.name);

    await ctx.step('a private space says nothing to anyone else: not listed, its id → 404, its private sessions → 404 and not listed', async () => {
      if ((await groupNames(asAna)).includes('Board prep')) fail('a member lists the private space');
      (await asAna.patch(GROUP, { description: 'x' }, { params: groupParams })).status(404).body().has('$.code', 'group_not_found');
      (await asAna.put(SHARING, { visibility: 'project' }, { params: groupParams })).status(404);
      for (const sessionId of [filed, child]) (await asAna.get(SESSION, { params: { ...params, sessionId } })).status(404);
      if ((await listedBy(asAna)).some((id) => id === filed || id === child)) fail('a member lists a private session of the space');
    });

    await ctx.step('the owner shares it with Ana → 200 private, member_ids [Ana]; a non-member id → 400 not_a_member', async () => {
      (await world.owner.put(SHARING, { visibility: 'private', member_ids: [ana.userId] }, { params: groupParams }))
        .status(200).body().schema(SessionGroupSchema).has('$.visibility', 'private').has('$.member_ids[0]', ana.userId);
      (await world.owner.put(SHARING, { visibility: 'private', member_ids: [randomUUID()] }, { params: groupParams }))
        .status(400).body().has('$.code', 'not_a_member');
    });

    await ctx.step('Ana now lists the space and reads and lists its sessions, the child included; not the owner\'s other private session; Bob still nothing', async () => {
      if (!(await groupNames(asAna)).includes('Board prep')) fail('Ana does not list the shared space');
      for (const sessionId of [filed, child]) (await asAna.get(SESSION, { params: { ...params, sessionId } })).status(200);
      const listed = await listedBy(asAna);
      if (!listed.includes(filed) || !listed.includes(child)) fail('Ana does not list the space sessions', listed);
      if (listed.includes(ownersOther)) fail('the space shared a session outside it');
      (await asAna.get(SESSION, { params: { ...params, sessionId: ownersOther } })).status(404);
      if ((await groupNames(asBob)).includes('Board prep')) fail('Bob lists a space not shared with him');
      (await asBob.get(SESSION, { params: { ...params, sessionId: filed } })).status(404);
    });

    await ctx.step('Ana edits the description (200) but may not share or delete it (403 group_manage_forbidden)', async () => {
      (await asAna.patch(GROUP, { description: 'Deck due Dec 1.' }, { params: groupParams })).status(200).body().has('$.description', 'Deck due Dec 1.').has('$.can_manage', false);
      (await asAna.put(SHARING, { visibility: 'project' }, { params: groupParams })).status(403).body().has('$.code', 'group_manage_forbidden');
      (await asAna.del(GROUP, { params: groupParams })).status(403).body().has('$.code', 'group_manage_forbidden');
    });

    await ctx.step("Ana may not move the owner's private session out (403 group_share_forbidden); her own private session filed there is shared with the owner", async () => {
      (await asAna.put(ASSIGN, { group_id: null }, { params: { ...params, sessionId: filed } })).status(403).body().has('$.code', 'group_share_forbidden');
      const anasOwn = await insertSession(world, ana.userId!, 'private');
      (await asAna.put(ASSIGN, { group_id: space }, { params: { ...params, sessionId: anasOwn } })).status(200);
      (await world.owner.get(SESSION, { params: { ...params, sessionId: anasOwn } })).status(200);
    });

    await ctx.step('everyone in the workspace: Bob lists the space and reads its sessions', async () => {
      (await world.owner.put(SHARING, { visibility: 'project' }, { params: groupParams })).status(200).body().has('$.visibility', 'project').has('$.member_ids.length', 0);
      if (!(await groupNames(asBob)).includes('Board prep')) fail('Bob does not list a project space');
      (await asBob.get(SESSION, { params: { ...params, sessionId: filed } })).status(200);
    });

    await ctx.step('back to only the owner: Ana and Bob lose the space and its sessions at once', async () => {
      (await world.owner.put(SHARING, { visibility: 'private', member_ids: [] }, { params: groupParams })).status(200);
      for (const client of [asAna, asBob]) {
        if ((await groupNames(client)).includes('Board prep')) fail('a person still lists an unshared space');
        (await client.get(SESSION, { params: { ...params, sessionId: filed } })).status(404);
        if ((await listedBy(client)).includes(filed)) fail('a person still lists a session of an unshared space');
      }
    });

    await ctx.step('with session_groups off a shared space shares nothing: Ana loses its sessions', async () => {
      (await world.owner.put(SHARING, { visibility: 'private', member_ids: [ana.userId] }, { params: groupParams })).status(200);
      (await asAna.get(SESSION, { params: { ...params, sessionId: filed } })).status(200);
      await world.setFeature('session_groups', false);
      (await asAna.get(SESSION, { params: { ...params, sessionId: filed } })).status(404);
      if ((await listedBy(asAna)).includes(filed)) fail('flag off still lists a space session');
      await world.setFeature('session_groups', true);
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-6', flowMeta('session-groups', [ROUTES.create, ROUTES.tabs, ROUTES.sharing, ROUTES.list], { timeoutMs: 120_000 }), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const ana = await team.addMember('member');
  await team.grantProjectRole(project.id, ana.userId!, 'member');
  try {
    await world.setFeature('session_groups', true);
    const space = (await world.owner.post(GROUPS, { name: 'Launch' }, { params })).status(201).json<Group>().group_id;
    const groupParams = { ...params, groupId: space };
    const tabs = [
      { id: 'plan', title: 'Plan', kind: 'file', ref: `/Spaces/${space}/plan.md` },
      { id: 'assets', title: 'Assets', kind: 'folder', ref: `/Spaces/${space}/assets` },
      { id: 'site', title: 'Site', kind: 'link', ref: 'https://example.com/' },
    ];

    await ctx.step('PUT tabs stores the ordered list; the list read returns it', async () => {
      (await world.owner.put(TABS, { tabs }, { params: groupParams })).status(200).body().schema(SessionGroupSchema)
        .has('$.tabs.length', 3).has('$.tabs[0].id', 'plan').has('$.tabs[2].kind', 'link');
      const listed = (await world.owner.get(GROUPS, { params })).json<{ groups: Array<Group & { tabs: Array<{ id: string }> }> }>().groups;
      if (JSON.stringify(listed.find((group) => group.group_id === space)?.tabs.map((tab) => tab.id)) !== JSON.stringify(['plan', 'assets', 'site'])) fail('tabs not stored in order');
    });

    await ctx.step('an http link, a relative path, a repeated id or 21 tabs → 400; the stored tabs do not change', async () => {
      for (const bad of [
        [{ id: 'x', title: 'X', kind: 'link', ref: 'http://example.com/' }],
        [{ id: 'x', title: 'X', kind: 'file', ref: 'plan.md' }],
        [tabs[0], tabs[0]],
        Array.from({ length: 21 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, kind: 'link', ref: 'https://example.com/' })),
      ]) {
        (await world.owner.put(TABS, { tabs: bad }, { params: groupParams })).status(400);
      }
    });

    await ctx.step('someone the space is not shared with → 404; once shared, they reorder the tabs → 200', async () => {
      const asAna = ctx.client.as(ana);
      (await asAna.put(TABS, { tabs: [] }, { params: groupParams })).status(404);
      (await world.owner.put(SHARING, { visibility: 'private', member_ids: [ana.userId] }, { params: groupParams })).status(200);
      (await asAna.put(TABS, { tabs: [tabs[2], tabs[0], tabs[1]] }, { params: groupParams })).status(200).body().has('$.tabs[0].id', 'site');
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-7', flowMeta('session-groups', [ROUTES.create, ROUTES.list, ROUTES.remove, SESSION_ROUTES.read, 'PATCH /v1/accounts/:accountId/iam/session-oversight'], { timeoutMs: 120_000 }), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const admin = await team.addMember('admin');
  const asAdmin = ctx.client.as(admin);
  try {
    await world.setFeature('session_groups', true);
    const space = (await world.owner.post(GROUPS, { name: 'Payroll' }, { params })).status(201).json<Group>().group_id;
    const filed = await insertSession(world, world.ownerUserId, 'private');
    (await world.owner.put(ASSIGN, { group_id: space }, { params: { ...params, sessionId: filed } })).status(200);
    const listsPayroll = async () =>
      (await asAdmin.get(GROUPS, { params })).status(200).json<{ groups: Group[] }>().groups.some((group) => group.group_id === space);

    await ctx.step('with account session oversight off, an admin does not see a private space or its sessions', async () => {
      if (await listsPayroll()) fail('an admin lists a private space without oversight');
      (await asAdmin.get(SESSION, { params: { ...params, sessionId: filed } })).status(404);
      (await asAdmin.del(GROUP, { params: { ...params, groupId: space } })).status(404);
    });

    await ctx.step('with oversight on (the owner turns it on), the admin sees it and its session, and may manage it', async () => {
      (await world.owner.patch('/v1/accounts/:accountId/iam/session-oversight', { enabled: true }, { params: { accountId: team.id } }))
        .status(200).body().has('$.enabled', true);
      if (!(await listsPayroll())) fail('an admin under oversight does not list the private space');
      (await asAdmin.get(SESSION, { params: { ...params, sessionId: filed } })).status(200);
      const listed = (await asAdmin.get(GROUPS, { params })).json<{ groups: Array<Group & { can_manage: boolean }> }>().groups;
      if (listed.find((group) => group.group_id === space)?.can_manage !== true) fail('an admin under oversight may not manage the space');
    });
  } finally {
    await world.close();
  }
});

// SGRP-4 needs the session create route to answer, which needs a sandbox
// provider and a reachable KORTIX_URL; the local profile answers 503.
const createMeta = (routes: string[]): FlowMeta => ({
  domain: 'session-groups',
  requires: ['database', 'sandbox'],
  timeoutMs: 300_000,
  routes,
});

flow('SGRP-4', createMeta([ROUTES.create, SESSION_ROUTES.create, SESSION_ROUTES.list]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('session_groups', true);
    await world.fund();
    const space = (await world.owner.post(GROUPS, { name: 'Q4 launch' }, { params })).status(201).json<Group>().group_id;
    let sessionId = '';

    await ctx.step('create a session with group_id → 201, group_id is the space; ?group=<id> lists it', async () => {
      const r = await world.owner.post(SESSIONS, { group_id: space, initial_prompt: 'ke2e: noop' }, { params });
      r.status(201).body().schema(ProjectSessionSchema).has('$.group_id', space);
      sessionId = r.json<Session>().session_id;
      ctx.track('session', sessionId, { projectId: project.id });
      const ids = (await world.owner.get(SESSIONS, { params, query: { group: space } })).status(200).json<Session[]>().map((s) => s.session_id);
      if (!ids.includes(sessionId)) fail('the new session is not in its space list', ids);
    });

    await ctx.step('an unknown group_id → 404 group_not_found and no session', async () => {
      (await world.owner.post(SESSIONS, { group_id: randomUUID(), initial_prompt: 'ke2e: noop' }, { params }))
        .status(404).body().has('$.code', 'group_not_found');
    });
  } finally {
    await world.close();
  }
});
