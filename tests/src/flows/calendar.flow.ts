/**
 * Calendar — a workspace's shared items with an owner and comments
 * (`/v1/projects/:projectId/calendar/*`, flag `calendar`). Spec:
 * tests/spec/end-to-end.md § 12f Calendar. Source of truth:
 * apps/api/src/projects/routes/calendar.ts + apps/api/src/projects/calendar/.
 *
 * The local profile runs no sandbox: an agent is a minted session
 * credential, and the reply that wakes its session is read as the queued
 * `system:calendar` session command, not as a turn.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext, Principal } from '../core/types';
import { AgentPrincipalsWorld, manifest } from '../fixtures/agent-principals';

/** `person:<id>` / `agent:<name>` per participant, in order. */
const who = (item: Item) => item.people.map((p) => (p.kind === 'person' ? `person:${p.user_id}` : `agent:${p.agent}`)).join();

const R = {
  list: '/v1/projects/:projectId/calendar',
  people: '/v1/projects/:projectId/calendar/people',
  item: '/v1/projects/:projectId/calendar/:itemId',
  comments: '/v1/projects/:projectId/calendar/:itemId/comments',
} as const;

interface Item {
  item_id: string;
  title: string;
  notes: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  status: 'open' | 'done';
  people: Array<{ kind: 'person'; user_id: string } | { kind: 'agent'; agent: string }>;
  created_by: { kind: 'person'; user_id: string } | { kind: 'agent'; agent: string; session_id: string | null };
  comment_count: number;
  completed_at: string | null;
}
interface InboxRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  calendar_item_id: string | null;
}

function expectError(r: { statusCode: number; json<T>(): T; text(): string }, status: number, code: string) {
  if (r.statusCode !== status) throw new Error(`expected ${status} ${code}, got ${r.statusCode}: ${r.text()}`);
  const body = r.json<{ error?: string; code?: string; violations?: string[] }>();
  if (body.error !== code && body.code !== code) throw new Error(`expected ${code}, got ${r.text()}`);
  if (code === 'calendar_invalid' && !body.violations?.length) throw new Error(`calendar_invalid without violations: ${r.text()}`);
}

async function mentionRows(ctx: FlowContext, who: Principal, itemId: string): Promise<InboxRow[]> {
  const page = (await ctx.client.as(who).get('/v1/notifications', { query: { limit: 50 } })).status(200).json<{ notifications: InboxRow[] }>();
  return page.notifications.filter((row) => row.kind === 'mention' && row.calendar_item_id === itemId);
}

async function waitForMentions(ctx: FlowContext, who: Principal, itemId: string, count: number): Promise<InboxRow[]> {
  const rows = await waitFor(() => mentionRows(ctx, who, itemId), {
    until: (found) => found.length >= count,
    timeoutMs: 15_000,
    intervalMs: 300,
    description: `${count} mention row(s) for ${who.label}`,
  });
  if (rows.length !== count) throw new Error(`${who.label}: expected ${count} mention row(s), got ${JSON.stringify(rows)}`);
  return rows;
}

flow(
  'CAL-1',
  {
    domain: 'calendar',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [`GET ${R.list}`, `POST ${R.list}`, `GET ${R.people}`, `GET ${R.item}`, `PATCH ${R.item}`, `DELETE ${R.item}`, `POST ${R.comments}`, 'PATCH /v1/projects/:projectId/features'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const memberPrincipal = await team.addMember('member');
    const project = await team.project({ managedGit: true });
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    try {
      await world.writeManifest(manifest('calendar'), 'ke2e: calendar agent');
      await world.setFeature('calendar', true);
      const owner = world.owner;
      const member = ctx.client.as(memberPrincipal);
      const params = { projectId: project.id };
      const ownerId = world.ownerUserId;
      const memberId = memberPrincipal.userId!;
      const commands = async (sessionId: string) =>
        Number((await world.db.query(
          `SELECT count(*)::int AS n FROM kortix.session_lifecycle_commands WHERE session_id = $1 AND source = 'system:calendar'`,
          [sessionId],
        )).rows[0]?.n ?? 0);

      await ctx.step('an anonymous caller → 401; the flag off → 403 feature_disabled on all 7 routes under /v1/workspaces and /v1/projects; on again → 200', async () => {
        (await ctx.client.as(ctx.P.ANON).get(R.list, { params })).status(401);
        await world.setFeature('calendar', false);
        const anyItem = { ...params, itemId: '00000000-0000-7000-8000-000000000000' };
        for (const prefix of ['/v1/workspaces', '/v1/projects']) {
          const at = (path: string) => path.replace('/v1/projects', prefix);
          expectError(await owner.get(at(R.list), { params }), 403, 'feature_disabled');
          expectError(await owner.post(at(R.list), { title: 'x' }, { params }), 403, 'feature_disabled');
          expectError(await owner.get(at(R.people), { params }), 403, 'feature_disabled');
          expectError(await owner.get(at(R.item), { params: anyItem }), 403, 'feature_disabled');
          expectError(await owner.patch(at(R.item), { title: 'x' }, { params: anyItem }), 403, 'feature_disabled');
          expectError(await owner.del(at(R.item), { params: anyItem }), 403, 'feature_disabled');
          expectError(await owner.post(at(R.comments), { body: 'x' }, { params: anyItem }), 403, 'feature_disabled');
        }
        await world.setFeature('calendar', true);
        (await owner.get(R.list, { params })).status(200);
      });

      let memberHandle = '';
      await ctx.step('people: the owner and the member, each with a unique handle, and the agent kortix', async () => {
        const body = (await owner.get(R.people, { params })).status(200).json<{ people: Array<{ user_id: string; handle: string; email: string | null }>; agents: Array<{ name: string }> }>();
        const mine = body.people.find((p) => p.user_id === memberId);
        if (!mine || !body.people.some((p) => p.user_id === ownerId)) throw new Error(JSON.stringify(body.people));
        if (new Set(body.people.map((p) => p.handle)).size !== body.people.length) throw new Error(`handles repeat: ${JSON.stringify(body.people)}`);
        if (!body.agents.some((a) => a.name === 'kortix')) throw new Error(JSON.stringify(body.agents));
        memberHandle = mine.handle;
      });

      let assigned: Item;
      await ctx.step('the owner creates a timed item with an end, with the member (by email), the agent kortix and themself → 201, people in the order sent; the member gets one "added you" row that opens the item; the owner gets none', async () => {
        assigned = (await owner.post(R.list, {
          title: 'Approve the launch post',
          starts_at: '2026-11-17T15:00:00+01:00',
          ends_at: '2026-11-17T16:00:00+01:00',
          people: [{ email: memberPrincipal.email }, { agent: 'kortix' }, { me: true }],
          notes: 'The draft is in Files.',
        }, { params })).status(201).json<{ item: Item }>().item;
        if (assigned.starts_at !== '2026-11-17T14:00:00.000Z' || assigned.ends_at !== '2026-11-17T15:00:00.000Z' || assigned.all_day || assigned.status !== 'open') throw new Error(JSON.stringify(assigned));
        if (assigned.created_by.kind !== 'person' || assigned.created_by.user_id !== ownerId) throw new Error(JSON.stringify(assigned.created_by));
        if (who(assigned) !== `person:${memberId},agent:kortix,person:${ownerId}`) throw new Error(JSON.stringify(assigned.people));
        const read = (await owner.get(R.item, { params: { ...params, itemId: assigned.item_id } })).status(200).json<{ item: Item }>().item;
        if (who(read) !== who(assigned) || read.ends_at !== assigned.ends_at) throw new Error(JSON.stringify(read));
        const [row] = await waitForMentions(ctx, memberPrincipal, assigned.item_id, 1);
        if (row!.title !== 'Approve the launch post' || !row!.body.endsWith('added you')) throw new Error(JSON.stringify(row));
        if (!row!.url.startsWith(`/projects/${project.id}/calendar?item=${assigned.item_id}&notification=`)) throw new Error(row!.url);
        if ((await mentionRows(ctx, ctx.P.OWNER, assigned.item_id)).length !== 0) throw new Error('the owner notified themself');
      });

      await ctx.step('all day keeps the written date; no date lists by default and not with undated=false; filters narrow as named', async () => {
        const allDay = (await owner.post(R.list, { title: 'Offsite', starts_at: '2026-11-16T00:00:00+09:00', all_day: true }, { params })).status(201).json<{ item: Item }>().item;
        if (allDay.starts_at !== '2026-11-16T00:00:00.000Z' || !allDay.all_day) throw new Error(JSON.stringify(allDay));
        const undated = (await owner.post(R.list, { title: 'Pick a venue' }, { params })).status(201).json<{ item: Item }>().item;
        if (undated.starts_at !== null) throw new Error(JSON.stringify(undated));
        const week = { from: '2026-11-16T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' };
        const ids = async (query: Record<string, string>) =>
          (await owner.get(R.list, { params, query })).status(200).json<{ items: Item[] }>().items.map((i) => i.item_id);
        const all = await ids(week);
        if (!all.includes(assigned.item_id) || !all.includes(allDay.item_id) || !all.includes(undated.item_id)) throw new Error(JSON.stringify(all));
        if ((await ids({ ...week, undated: 'false' })).includes(undated.item_id)) throw new Error('undated=false listed an item with no date');
        const theirs = await ids({ ...week, with: `user:${memberId}`, undated: 'false' });
        if (theirs.join() !== assigned.item_id) throw new Error(JSON.stringify(theirs));
        if ((await ids({ ...week, with: 'me', undated: 'false' })).join() !== assigned.item_id) throw new Error('with=me did not list the owner\'s item');
        if ((await ids({ ...week, with: 'agent:kortix', undated: 'false' })).join() !== assigned.item_id) throw new Error('with=agent:kortix did not list the item');
        if ((await ids({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-08T00:00:00.000Z', undated: 'false' })).length !== 0) throw new Error('a window with no item listed items');
      });

      await ctx.step('bad input → 422 calendar_invalid with violations; a non-uuid or unknown item → 404 calendar_not_found', async () => {
        expectError(await owner.post(R.list, { title: '   ' }, { params }), 422, 'calendar_invalid');
        expectError(await owner.post(R.list, { title: 'x', people: [{ agent: 'nobody-here' }] }, { params }), 422, 'calendar_invalid');
        expectError(await owner.post(R.list, { title: 'x', people: [{ email: 'stranger@example.test' }] }, { params }), 422, 'calendar_invalid');
        expectError(await owner.post(R.list, { title: 'x', starts_at: '2026-11-17T10:00:00Z', ends_at: '2026-11-17T10:00:00Z' }, { params }), 422, 'calendar_invalid');
        expectError(await owner.post(R.list, { title: 'x', starts_at: '2026-11-17T00:00:00Z', all_day: true, ends_at: '2026-11-17T10:00:00Z' }, { params }), 422, 'calendar_invalid');
        expectError(await owner.post(R.list, { title: 'x', ends_at: '2026-11-17T10:00:00Z' }, { params }), 422, 'calendar_invalid');
        expectError(await owner.get(R.list, { params, query: { with: 'user:not-a-uuid' } }), 422, 'calendar_invalid');
        expectError(await owner.get(R.list, { params, query: { with: 'everyone' } }), 422, 'calendar_invalid');
        expectError(await owner.get(R.list, { params, query: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } }), 422, 'calendar_invalid');
        expectError(await owner.get(R.list, { params, query: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } }), 422, 'calendar_invalid');
        expectError(await owner.get(R.item, { params: { ...params, itemId: 'not-an-id' } }), 404, 'calendar_not_found');
        expectError(await owner.get(R.item, { params: { ...params, itemId: '00000000-0000-7000-8000-000000000000' } }), 404, 'calendar_not_found');
      });

      await ctx.step('PATCH people replaces the whole list, [] empties it; a moved timed item keeps its length; all day drops the end', async () => {
        const patch = async (body: Record<string, unknown>) =>
          (await owner.patch(R.item, body, { params: { ...params, itemId: assigned.item_id } })).status(200).json<{ item: Item }>().item;
        if (who(await patch({ people: [{ agent: 'kortix' }, { user_id: memberId }] })) !== `person:${memberId},agent:kortix`) throw new Error('people were not replaced (the ones who stay keep their order)');
        if ((await mentionRows(ctx, memberPrincipal, assigned.item_id)).length !== 1) throw new Error('a person already on the item was notified again');
        if ((await patch({ people: [] })).people.length !== 0) throw new Error('people: [] left people on the item');
        const moved = await patch({ starts_at: '2026-11-19T09:00:00Z' });
        if (moved.starts_at !== '2026-11-19T09:00:00.000Z' || moved.ends_at !== '2026-11-19T10:00:00.000Z') throw new Error(JSON.stringify(moved));
        const allDay = await patch({ starts_at: '2026-11-19T00:00:00Z', all_day: true });
        if (!allDay.all_day || allDay.ends_at !== null) throw new Error(JSON.stringify(allDay));
        expectError(await owner.patch(R.item, { ends_at: '2026-11-19T12:00:00Z' }, { params: { ...params, itemId: assigned.item_id } }), 422, 'calendar_invalid');
        const timed = await patch({ starts_at: '2026-11-17T15:00:00+01:00', all_day: false, ends_at: '2026-11-17T16:00:00+01:00', people: [{ user_id: memberId }] });
        if (timed.ends_at !== '2026-11-17T15:00:00.000Z' || who(timed) !== `person:${memberId}`) throw new Error(JSON.stringify(timed));
      });

      const agent = await world.mintAgentSession({ agent: 'kortix', launcher: ctx.P.OWNER });
      let asked: Item;
      await ctx.step('an agent session creates an item with itself on it that mentions the member → the agent is author and on it; the member gets a mention row', async () => {
        asked = (await agent.client.post(R.list, {
          title: 'Review the pricing page',
          starts_at: '2026-11-18T09:00:00Z',
          people: [{ me: true }],
          notes: `@${memberHandle} please check the numbers.`,
        }, { params })).status(201).json<{ item: Item }>().item;
        if (asked.created_by.kind !== 'agent' || asked.created_by.agent !== 'kortix' || asked.created_by.session_id !== agent.sessionId) throw new Error(JSON.stringify(asked.created_by));
        if (who(asked) !== 'agent:kortix') throw new Error(JSON.stringify(asked.people));
        const [row] = await waitForMentions(ctx, memberPrincipal, asked.item_id, 1);
        if (!row!.body.includes('please check the numbers')) throw new Error(JSON.stringify(row));
      });

      await ctx.step('the flag off again → the agent session gets 403; the member’s mention rows leave the inbox and the unread count; on again → they are back', async () => {
        const unread = async () => (await member.get('/v1/notifications', { query: { limit: 50 } })).status(200).json<{ unread_count: number }>().unread_count;
        const before = await unread();
        await world.setFeature('calendar', false);
        expectError(await agent.client.get(R.list, { params }), 403, 'feature_disabled');
        if ((await mentionRows(ctx, memberPrincipal, asked.item_id)).length !== 0) throw new Error('a mention row showed with the flag off');
        const off = await unread();
        if (off >= before) throw new Error(`unread_count did not drop with the flag off: ${before} → ${off}`);
        await world.setFeature('calendar', true);
        if ((await mentionRows(ctx, memberPrincipal, asked.item_id)).length !== 1) throw new Error('the mention row did not come back with the flag on');
        if ((await unread()) !== before) throw new Error(`unread_count did not come back: ${before} → ${await unread()}`);
      });

      await ctx.step('the owner’s comment wakes the agent session once; the agent’s own comment wakes nobody; done and reopen move completed_at, and done wakes it again', async () => {
        const comment = (await owner.post(R.comments, { body: 'Numbers look right. @nobody-at-all' }, { params: { ...params, itemId: asked.item_id } })).status(201).json<{ comment: { author: { kind: string; user_id?: string } } }>().comment;
        if (comment.author.kind !== 'person' || comment.author.user_id !== ownerId) throw new Error(JSON.stringify(comment));
        if ((await commands(agent.sessionId)) !== 1) throw new Error(`commands after the owner's comment: ${await commands(agent.sessionId)}`);
        (await agent.client.post(R.comments, { body: 'Thanks, publishing.' }, { params: { ...params, itemId: asked.item_id } })).status(201);
        if ((await commands(agent.sessionId)) !== 1) throw new Error('an agent comment woke the session');
        const detail = (await owner.get(R.item, { params: { ...params, itemId: asked.item_id } })).status(200).json<{ item: Item; comments: Array<{ author: { kind: string } }> }>();
        if (detail.item.comment_count !== 2 || detail.comments.map((c) => c.author.kind).join() !== 'person,agent') throw new Error(JSON.stringify(detail));
        const done = (await owner.patch(R.item, { status: 'done' }, { params: { ...params, itemId: asked.item_id } })).status(200).json<{ item: Item }>().item;
        if (done.status !== 'done' || !done.completed_at) throw new Error(JSON.stringify(done));
        if ((await commands(agent.sessionId)) !== 2) throw new Error(`commands after done: ${await commands(agent.sessionId)}`);
        const reopened = (await owner.patch(R.item, { status: 'open', starts_at: null }, { params: { ...params, itemId: asked.item_id } })).status(200).json<{ item: Item }>().item;
        if (reopened.status !== 'open' || reopened.completed_at !== null || reopened.starts_at !== null) throw new Error(JSON.stringify(reopened));
      });

      await ctx.step('a person who mentions themself is not notified; the member creates and comments, and the owner is notified by the mention', async () => {
        const ownerHandle = (await owner.get(R.people, { params })).status(200).json<{ people: Array<{ user_id: string; handle: string }> }>().people.find((p) => p.user_id === ownerId)!.handle;
        (await owner.post(R.comments, { body: `Note to self @${ownerHandle}` }, { params: { ...params, itemId: assigned.item_id } })).status(201);
        if ((await mentionRows(ctx, ctx.P.OWNER, assigned.item_id)).length !== 0) throw new Error('a self-mention notified its author');
        const own = (await member.post(R.list, { title: 'Book the room' }, { params })).status(201).json<{ item: Item }>().item;
        (await member.post(R.comments, { body: `@${ownerHandle} can you approve the budget?` }, { params: { ...params, itemId: own.item_id } })).status(201);
        const [row] = await waitForMentions(ctx, ctx.P.OWNER, own.item_id, 1);
        if (!row!.body.includes('can you approve the budget')) throw new Error(JSON.stringify(row));
      });

      await ctx.step('DELETE → 200, then 404; the member’s mention rows for the item leave the inbox', async () => {
        (await owner.del(R.item, { params: { ...params, itemId: assigned.item_id } })).status(200).body().has('$.deleted', true);
        expectError(await owner.get(R.item, { params: { ...params, itemId: assigned.item_id } }), 404, 'calendar_not_found');
        expectError(await owner.del(R.item, { params: { ...params, itemId: assigned.item_id } }), 404, 'calendar_not_found');
        if ((await mentionRows(ctx, memberPrincipal, assigned.item_id)).length !== 0) throw new Error('a deleted item still shows in the inbox');
      });
    } finally {
      await world.close();
    }
  },
);
