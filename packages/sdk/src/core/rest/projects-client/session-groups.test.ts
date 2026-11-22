import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  createWorkspaceSessionGroup,
  deleteWorkspaceSessionGroup,
  listWorkspaceSessionGroups,
  renameWorkspaceSessionGroup,
  reorderWorkspaceSessionGroups,
  setWorkspaceSessionGroup,
  setWorkspaceSessionGroupSharing,
  setWorkspaceSessionGroupTabs,
  updateWorkspaceSessionGroup,
  type ProjectSessionGroup,
} from './session-groups';
import { listWorkspaceSessionsPage } from './sessions';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

const storeA: ProjectSessionGroup = {
  group_id: '00000000-0000-4000-8000-00000000000a',
  name: 'Store A',
  description: null,
  visibility: 'private',
  member_ids: [],
  tabs: [],
  can_manage: true,
  position: 0,
  created_by: '00000000-0000-4000-8000-000000000001',
  created_at: '2026-10-27T00:00:00.000Z',
  updated_at: '2026-10-27T00:00:00.000Z',
};
const storeB: ProjectSessionGroup = { ...storeA, group_id: '00000000-0000-4000-8000-00000000000b', name: 'Store B', position: 1 };

test('listProjectSessionGroups GETs the project groups and returns the array in order', async () => {
  nextResponse = { status: 200, body: { groups: [storeA, storeB] } };
  expect(await listWorkspaceSessionGroups('P1')).toEqual([storeA, storeB]);
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/session-groups', method: 'GET', body: undefined }]);
});

test('listWorkspaceSessionGroups returns each group with its activity: session_count and last_activity_at', async () => {
  // Typed fields: this object only compiles when the type declares them.
  const active: ProjectSessionGroup = { ...storeA, session_count: 3, last_activity_at: '2026-11-18T10:00:00.000Z' };
  const idle: ProjectSessionGroup = { ...storeB, session_count: 0, last_activity_at: null };
  nextResponse = { status: 200, body: { groups: [active, idle] } };
  const [first, second] = await listWorkspaceSessionGroups('P1');
  expect(first?.session_count).toBe(3);
  expect(first?.last_activity_at).toBe('2026-11-18T10:00:00.000Z');
  expect(second?.session_count).toBe(0);
  expect(second?.last_activity_at).toBeNull();
});

test('createProjectSessionGroup POSTs { name } and returns the group', async () => {
  nextResponse = { status: 201, body: storeA };
  expect(await createWorkspaceSessionGroup('P1', { name: 'Store A' })).toEqual(storeA);
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/session-groups', method: 'POST', body: { name: 'Store A' } }]);
});

test('renameProjectSessionGroup PATCHes { name } on the group', async () => {
  nextResponse = { status: 200, body: { ...storeA, name: 'Store A (EU)' } };
  expect((await renameWorkspaceSessionGroup('P1', storeA.group_id, 'Store A (EU)')).name).toBe('Store A (EU)');
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/session-groups/${storeA.group_id}`, method: 'PATCH', body: { name: 'Store A (EU)' } },
  ]);
});

test('createWorkspaceSessionGroup POSTs a description with the name', async () => {
  nextResponse = { status: 201, body: { ...storeA, description: 'Launch plan' } };
  expect((await createWorkspaceSessionGroup('P1', { name: 'Store A', description: 'Launch plan' })).description).toBe('Launch plan');
  expect(calls[0]!.body).toEqual({ name: 'Store A', description: 'Launch plan' });
});

test('updateWorkspaceSessionGroup PATCHes only the fields given; null clears the description', async () => {
  nextResponse = { status: 200, body: { ...storeA, description: null } };
  expect((await updateWorkspaceSessionGroup('P1', storeA.group_id, { description: null })).description).toBeNull();
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/session-groups/${storeA.group_id}`, method: 'PATCH', body: { description: null } },
  ]);
});

test('updateWorkspaceSessionGroup rejects a taken name with ApiError group_name_taken', async () => {
  nextResponse = { status: 409, body: { error: 'taken', code: 'group_name_taken' } };
  const error = await updateWorkspaceSessionGroup('P1', storeA.group_id, { name: 'Store B' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('group_name_taken');
});

test('setWorkspaceSessionGroupSharing PUTs who sees the group and returns it', async () => {
  const ana = '00000000-0000-4000-8000-0000000000aa';
  nextResponse = { status: 200, body: { ...storeA, member_ids: [ana] } };
  expect((await setWorkspaceSessionGroupSharing('P1', storeA.group_id, { visibility: 'private', member_ids: [ana] })).member_ids).toEqual([ana]);
  expect(calls).toEqual([
    {
      url: `http://test.local/v1/workspaces/P1/session-groups/${storeA.group_id}/sharing`,
      method: 'PUT',
      body: { visibility: 'private', member_ids: [ana] },
    },
  ]);
});

test('setWorkspaceSessionGroupSharing rejects a caller who may not manage it with ApiError group_manage_forbidden', async () => {
  nextResponse = { status: 403, body: { error: 'no', code: 'group_manage_forbidden' } };
  const error = await setWorkspaceSessionGroupSharing('P1', storeA.group_id, { visibility: 'project' }).catch((e: unknown) => e);
  expect((error as ApiError).code).toBe('group_manage_forbidden');
});

test('setWorkspaceSessionGroupTabs PUTs the whole ordered list', async () => {
  const tabs = [{ id: 'plan', title: 'Plan', kind: 'file' as const, ref: '/Spaces/g/plan.md' }];
  nextResponse = { status: 200, body: { ...storeA, tabs } };
  expect((await setWorkspaceSessionGroupTabs('P1', storeA.group_id, tabs)).tabs).toEqual(tabs);
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/session-groups/${storeA.group_id}/tabs`, method: 'PUT', body: { tabs } },
  ]);
});

test('deleteProjectSessionGroup DELETEs the group', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  expect(await deleteWorkspaceSessionGroup('P1', storeA.group_id)).toBeUndefined();
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/session-groups/${storeA.group_id}`, method: 'DELETE', body: undefined },
  ]);
});

test('reorderProjectSessionGroups PUTs every id in the new order and returns the ordered list', async () => {
  const reordered = [{ ...storeB, position: 0 }, { ...storeA, position: 1 }];
  nextResponse = { status: 200, body: { groups: reordered } };
  expect(await reorderWorkspaceSessionGroups('P1', [storeB.group_id, storeA.group_id])).toEqual(reordered);
  expect(calls).toEqual([
    {
      url: 'http://test.local/v1/workspaces/P1/session-groups/order',
      method: 'PUT',
      body: { group_ids: [storeB.group_id, storeA.group_id] },
    },
  ]);
});

test('setProjectSessionGroup PUTs { group_id } on the session, and null takes it out', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', group_id: storeA.group_id } };
  expect(await setWorkspaceSessionGroup('P1', 'S1', storeA.group_id)).toEqual({ session_id: 'S1', group_id: storeA.group_id });
  nextResponse = { status: 200, body: { session_id: 'S1', group_id: null } };
  expect(await setWorkspaceSessionGroup('P1', 'S1', null)).toEqual({ session_id: 'S1', group_id: null });
  expect(calls).toEqual([
    { url: 'http://test.local/v1/workspaces/P1/sessions/S1/group', method: 'PUT', body: { group_id: storeA.group_id } },
    { url: 'http://test.local/v1/workspaces/P1/sessions/S1/group', method: 'PUT', body: { group_id: null } },
  ]);
});

test('a refusal (409 group_name_taken) rejects with ApiError and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 409, body: { error: 'Another group in this project already has that name.', code: 'group_name_taken' } };
  const error = await createWorkspaceSessionGroup('P1', { name: 'store a' }).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, code: 'group_name_taken' });
  expect(errors).toEqual([]);
});

test('listProjectSessionsPage sends group as ?group=<id>, or none', async () => {
  nextResponse = { status: 200, body: [] };
  await listWorkspaceSessionsPage('P1', { group: storeA.group_id });
  await listWorkspaceSessionsPage('P1', { group: 'none' });
  expect(calls.map((call) => new URL(call.url).searchParams.get('group'))).toEqual([storeA.group_id, 'none']);
});
