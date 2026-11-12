/**
 * The decisions of the Teams read confinement, against a fake ownership
 * source, and the classification of every Slack and Teams action. The SQL
 * behind the real source is proven on PostgreSQL in
 * `__tests__/integration-channel-read-scope.test.ts`. Slack reads follow the
 * link and the person's view instead: slack-visibility.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_READ_SCOPES,
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelOwnership,
  type ChannelReadGate,
  gateChannelRead,
} from './channel-read-scope';
import { channelCatalog } from './channels';

const MINE = 'project-mine';
const OTHER = 'project-other';
const WS = 'T0WORKSPACE';

interface Rows {
  /** No install on record when empty. */
  workspaces?: string[];
  /** Another project is connected to the workspace. */
  shared?: boolean;
  /** Normalized channel id → projects with a conversation in it. */
  channels?: Record<string, string[]>;
  /** Normalized thread id → owning project. */
  threads?: Record<string, string>;
}

function fake(rows: Rows) {
  const lookups: string[] = [];
  const ownership: ChannelOwnership = {
    async installs() {
      lookups.push('installs');
      return { workspaceIds: rows.workspaces ?? [WS], shared: rows.shared ?? false };
    },
    async channelProjects(_platform, _ws, ids) {
      lookups.push(`channels:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.channels?.[id]).map((id) => [id, new Set(rows.channels![id])]));
    },
    async threadOwners(_platform, _ws, ids) {
      lookups.push(`threads:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.threads?.[id]).map((id) => [id, rows.threads![id]!]));
    },
  };
  return { ownership, lookups };
}

function gate(
  rows: Rows,
  platform: string,
  actionPath: string,
  args: Record<string, unknown> = {},
  risk = 'read',
): Promise<ChannelReadGate> {
  return gateChannelRead({ projectId: MINE, platform, actionPath, args, risk }, fake(rows).ownership);
}

function refusalOf(g: ChannelReadGate): string {
  expect(g.refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return g.refusal!.message;
}

async function answered(g: ChannelReadGate, data: unknown): Promise<unknown> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if ('refusal' in res) throw new Error(`answer refused: ${res.refusal.message}`);
  return res.data;
}

async function answerRefusal(g: ChannelReadGate, data: unknown): Promise<string> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if (!('refusal' in res)) throw new Error('answer was not refused');
  expect(res.refusal.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return res.refusal.message;
}

describe('every catalog action is classified', () => {
  for (const platform of ['slack', 'teams'] as const) {
    test(`${platform}: the scope table covers exactly the catalog, and only non-reads are writes`, () => {
      const catalog = channelCatalog(platform);
      expect(Object.keys(CHANNEL_READ_SCOPES[platform]).sort()).toEqual(catalog.map((a) => a.path).sort());
      for (const action of catalog) {
        const scope = CHANNEL_READ_SCOPES[platform][action.path];
        expect(`${action.path}:${scope === 'write'}`).toBe(`${action.path}:${action.risk !== 'read'}`);
      }
    });
  }

  test('an unclassified read is refused; an unclassified write and other platforms pass', async () => {
    expect(refusalOf(await gate({}, 'slack', 'pins_list'))).toContain('pins_list');
    expect((await gate({}, 'slack', 'pins_add', {}, 'write')).refusal).toBeNull();
    expect((await gate({}, 'email', 'list_messages')).refusal).toBeNull();
    expect((await gate({}, 'slack', 'constructor')).refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  });

  test('directory reads and writes run without a single ownership lookup', async () => {
    for (const [platform, action] of [
      ['teams', 'get_user'],
      ['teams', 'list_teams'],
    ] as const) {
      const { ownership, lookups } = fake({ shared: true });
      const g = await gateChannelRead(
        { projectId: MINE, platform, actionPath: action, args: { channel: 'C0OTHER' }, risk: 'read' },
        ownership,
      );
      expect(g.refusal).toBeNull();
      expect(await g.answer({ ok: true })).toEqual({ data: { ok: true } });
      expect(lookups).toEqual([]);
    }
  });
});

describe('Teams reads', () => {
  const CH = '19:chan@thread.tacv2';
  const ONLY_OTHER = '19:onlyother@thread.tacv2';
  const rows: Rows = {
    shared: true,
    channels: { [CH]: [MINE, OTHER], [ONLY_OTHER]: [OTHER] },
    threads: { [`${CH};messageid=1`]: MINE, [`${CH};messageid=2`]: OTHER },
  };

  test('a channel this project has a conversation in is read; the answer drops other projects\' threads', async () => {
    const g = await gate(rows, 'teams', 'list_messages', { 'team-id': 'team', 'channel-id': CH });
    const data = await answered(g, {
      '@odata.context': 'ctx',
      value: [
        { id: '1', replyToId: null, body: { content: 'mine' } },
        { id: '2', replyToId: null, body: { content: 'other' } },
        { id: '3', replyToId: null, body: { content: 'nobody' } },
      ],
    });
    expect((data as { value: Array<{ id: string }> }).value.map((m) => m.id)).toEqual(['1', '3']);
  });

  test('a channel only other projects have conversations in is refused', async () => {
    expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'team-id': 't', 'channel-id': ONLY_OTHER }))).toBe(
      "Teams channel 19:onlyother@thread.tacv2 belongs to another Kortix workspace. This workspace's Microsoft Teams connector reads only its own conversations.",
    );
  });

  test('a channel no project has a conversation in: read while alone in the tenant, refused once shared', async () => {
    const args = { 'team-id': 't', 'channel-id': '19:quiet@thread.tacv2' };
    expect((await gate({ shared: false }, 'teams', 'list_messages', args)).refusal).toBeNull();
    expect(refusalOf(await gate({ shared: true }, 'teams', 'list_messages', args))).toContain('Mention the bot in that channel');
  });

  test('ids compare lowercase on both sides; other shapes are refused', async () => {
    expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'channel-id': '19:ONLYOTHER@thread.tacv2' }))).toContain(
      'another Kortix workspace',
    );
    for (const id of [`${CH};messageid=1`, `${CH} `, '19:a/../b@thread.tacv2', 'chan', 42]) {
      expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'channel-id': id }))).toContain('`channel-id`');
    }
  });

  test('a thread follows its own owner first, then its channel', async () => {
    const args = (m: string) => ({ 'team-id': 't', 'channel-id': CH, 'message-id': m });
    expect((await gate(rows, 'teams', 'get_message', args('1'))).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'teams', 'list_replies', args('2')))).toContain('Teams thread 2 in 19:chan@thread.tacv2');
    expect((await gate(rows, 'teams', 'list_replies', args('3'))).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'teams', 'get_message', args('x')))).toContain('`message-id`');
  });

  test('a message answered from another project\'s thread is refused on the answer', async () => {
    const g = await gate(rows, 'teams', 'get_message', { 'team-id': 't', 'channel-id': CH, 'message-id': '3' });
    expect(await answerRefusal(g, { id: '9', replyToId: '2', body: { content: 'reply' } })).toContain('another Kortix workspace');
  });

  test('channel metadata: standard channels are directory data, private ones follow their owner', async () => {
    const standard = { id: ONLY_OTHER, membershipType: 'standard', displayName: 'General' };
    expect(await answered(await gate(rows, 'teams', 'get_channel', { 'channel-id': ONLY_OTHER }), standard)).toEqual(standard);
    const priv = { id: ONLY_OTHER, membershipType: 'private', displayName: 'Secret' };
    expect(await answerRefusal(await gate(rows, 'teams', 'get_channel', { 'channel-id': ONLY_OTHER }), priv)).toContain(
      'another Kortix workspace',
    );
    const list = await answered(await gate(rows, 'teams', 'list_channels', { 'team-id': 't' }), {
      value: [
        { id: ONLY_OTHER, membershipType: 'standard' },
        { id: CH, membershipType: 'private' },
        { id: '19:secret@thread.tacv2', membershipType: 'shared' },
        { id: ONLY_OTHER, membershipType: 'private' },
      ],
    });
    expect((list as { value: Array<{ id: string; membershipType: string }> }).value).toEqual([
      { id: ONLY_OTHER, membershipType: 'standard' },
      { id: CH, membershipType: 'private' },
    ]);
  });
});
