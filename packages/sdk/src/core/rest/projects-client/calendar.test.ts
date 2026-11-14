import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  addWorkspaceCalendarComment,
  createWorkspaceCalendarItem,
  deleteWorkspaceCalendarItem,
  getWorkspaceCalendarItem,
  listWorkspaceCalendarItems,
  listWorkspaceCalendarPeople,
  updateWorkspaceCalendarItem,
  type CalendarComment,
  type CalendarItem,
} from './calendar';

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

type Call = { method: string; key: string; body: unknown };

function serve(routes: Record<string, { status: number; body: unknown }>, calls: Call[]) {
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const raw = init.body != null ? await new Response(init.body as BodyInit).text() : '';
    calls.push({ method, key, body: raw ? JSON.parse(raw) : null });
    const route = routes[key] ?? { status: 404, body: { error: 'calendar_not_found', message: 'Calendar item not found.' } };
    return new Response(JSON.stringify(route.body), { status: route.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const ITEM: CalendarItem = {
  item_id: '0193c8a0-0000-7000-8000-000000000001',
  project_id: 'p1',
  title: 'Approve the Q4 budget',
  notes: '@ana please approve',
  starts_at: '2026-11-16T15:00:00.000Z',
  all_day: false,
  status: 'open',
  assignee: { kind: 'person', user_id: 'u-ana' },
  created_by: { kind: 'agent', agent: 'finance', session_id: 's1' },
  comment_count: 1,
  completed_at: null,
  created_at: '2026-11-14T10:00:00.000Z',
  updated_at: '2026-11-14T10:00:00.000Z',
};
const COMMENT: CalendarComment = {
  comment_id: 'c1',
  item_id: ITEM.item_id,
  body: 'Approved.',
  author: { kind: 'person', user_id: 'u-ana' },
  created_at: '2026-11-14T11:00:00.000Z',
};
const base = '/workspaces/p1/calendar';

describe('calendar client', () => {
  let calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {};
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(routes)) delete routes[key];
    serve(routes, calls);
  });

  test('list sends the window, the filters and undated=false only when asked', async () => {
    const from = '2026-11-09T00:00:00.000Z';
    const to = '2026-11-16T00:00:00.000Z';
    routes[`GET ${base}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&assignee=me&undated=false`] = { status: 200, body: { items: [ITEM] } };
    routes[`GET ${base}`] = { status: 200, body: { items: [] } };

    expect(await listWorkspaceCalendarItems('p1', { from, to, assignee: 'me', undated: false })).toEqual([ITEM]);
    expect(await listWorkspaceCalendarItems('p1')).toEqual([]);
    expect(calls.map((c) => c.key)).toEqual([
      `GET ${base}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&assignee=me&undated=false`,
      `GET ${base}`,
    ]);
  });

  test('create, update, delete and comment write their routes with the body as given', async () => {
    routes[`POST ${base}`] = { status: 201, body: { item: ITEM } };
    routes[`PATCH ${base}/${ITEM.item_id}`] = { status: 200, body: { item: { ...ITEM, status: 'done' } } };
    routes[`DELETE ${base}/${ITEM.item_id}`] = { status: 200, body: { deleted: true } };
    routes[`POST ${base}/${ITEM.item_id}/comments`] = { status: 201, body: { comment: COMMENT } };

    const created = await createWorkspaceCalendarItem('p1', {
      title: 'Approve the Q4 budget',
      starts_at: '2026-11-16T15:00:00.000Z',
      assignee: { email: 'ana@example.test' },
      notes: '@ana please approve',
    });
    expect(created).toEqual(ITEM);
    expect((await updateWorkspaceCalendarItem('p1', ITEM.item_id, { status: 'done', starts_at: null })).status).toBe('done');
    await deleteWorkspaceCalendarItem('p1', ITEM.item_id);
    expect(await addWorkspaceCalendarComment('p1', ITEM.item_id, 'Approved.')).toEqual(COMMENT);

    expect(calls.map((c) => [c.key, c.body])).toEqual([
      [`POST ${base}`, { title: 'Approve the Q4 budget', starts_at: '2026-11-16T15:00:00.000Z', assignee: { email: 'ana@example.test' }, notes: '@ana please approve' }],
      [`PATCH ${base}/${ITEM.item_id}`, { status: 'done', starts_at: null }],
      [`DELETE ${base}/${ITEM.item_id}`, null],
      [`POST ${base}/${ITEM.item_id}/comments`, { body: 'Approved.' }],
    ]);
  });

  test('an item read returns the item with its comments; people returns people and agents', async () => {
    routes[`GET ${base}/${ITEM.item_id}`] = { status: 200, body: { item: ITEM, comments: [COMMENT] } };
    routes[`GET ${base}/people`] = {
      status: 200,
      body: { people: [{ user_id: 'u-ana', name: 'Ana Lima', email: 'ana@example.test', avatar_url: null, handle: 'ana-lima' }], agents: [{ name: 'finance' }] },
    };

    expect(await getWorkspaceCalendarItem('p1', ITEM.item_id)).toEqual({ item: ITEM, comments: [COMMENT] });
    const directory = await listWorkspaceCalendarPeople('p1');
    expect(directory.people[0]!.handle).toBe('ana-lima');
    expect(directory.agents).toEqual([{ name: 'finance' }]);
  });

  test('an item id is path-encoded', async () => {
    routes[`GET ${base}/a%2Fb`] = { status: 200, body: { item: ITEM, comments: [] } };
    await getWorkspaceCalendarItem('p1', 'a/b');
    expect(calls[0]!.key).toBe(`GET ${base}/a%2Fb`);
  });

  test('a refusal throws ApiError with the status and the server code', async () => {
    routes[`GET ${base}`] = { status: 403, body: { error: 'Calendar is not enabled for this workspace.', code: 'feature_disabled', feature: 'calendar' } };
    const refused = await listWorkspaceCalendarItems('p1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);

    const missing = await getWorkspaceCalendarItem('p1', 'nope').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
  });
});
