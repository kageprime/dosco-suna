/**
 * The decisions of the Slack read gate against fake link and view sources:
 * the link decides whether this Kortix workspace reads at all, and a private
 * conversation is readable only when the session's person is in it.
 */
import { describe, expect, test } from 'bun:test';
import { CHANNEL_READ_SCOPES, type ChannelReadGate, type ChannelReadScope, gateChannelRead } from './channel-read-scope';
import { SLACK_NOT_LINKED, SLACK_PRIVATE_CONVERSATION, type SlackReadDeps, type SlackView, slackPrivateWrite } from './slack-visibility';

const MINE = 'project-mine';
/** G0FIN: private, the person is in it. G0EXEC: private, they are not. D0WITHME: their DM with the bot. C0PUBLIC: public. */
const VIEW: SlackView = {
  privateIds: new Set(['G0FIN', 'G0EXEC', 'D0WITHME', 'D0WITHSAM']),
  allowedIds: new Set(['G0FIN', 'D0WITHME']),
  hasPerson: true,
};

function deps(opts: { linked?: boolean; view?: SlackView | null } = {}) {
  const calls: string[] = [];
  const slack: SlackReadDeps = {
    async link() {
      calls.push('link');
      return opts.linked === false ? null : { teamId: 'T0SYNTH01' };
    },
    async view(_projectId, _teamId, userId) {
      calls.push(`view:${userId}`);
      return opts.view === undefined ? VIEW : opts.view;
    },
  };
  return { slack, calls };
}

function gate(actionPath: string, args: Record<string, unknown>, slack: SlackReadDeps): Promise<ChannelReadGate> {
  return gateChannelRead({ projectId: MINE, userId: 'user-1', platform: 'slack', actionPath, args, risk: 'read' }, undefined, slack);
}

async function answer(g: ChannelReadGate, data: unknown) {
  expect(g.refusal).toBeNull();
  return g.answer(data);
}

describe('the link', () => {
  test('a Kortix workspace that does not hold the Slack workspace reads nothing, not even the directory', async () => {
    for (const [action, args] of [
      ['get_history', { channel: 'C0PUBLIC' }],
      ['list_channels', {}],
      ['list_users', {}],
    ] as const) {
      const { slack } = deps({ linked: false });
      const g = await gate(action, args, slack);
      expect(g.refusal?.reason).toBe(SLACK_NOT_LINKED);
    }
  });

  test('writes are left to the write gate', async () => {
    const { slack, calls } = deps({ linked: false });
    expect((await gate('send_message', { channel: 'C0PUBLIC' }, slack)).refusal).toBeNull();
    expect(calls).toEqual([]);
  });

  test('the directory is read once the link holds, with no membership lookup', async () => {
    const { slack, calls } = deps();
    expect((await gate('list_users', {}, slack)).refusal).toBeNull();
    expect(calls).toEqual(['link']);
  });
});

describe('private content follows the person', () => {
  test('a public channel is read by any session; a private one only by a session of someone in it', async () => {
    const { slack, calls } = deps();
    expect((await gate('get_history', { channel: 'C0PUBLIC' }, slack)).refusal).toBeNull();
    expect((await gate('get_history', { channel: 'G0FIN' }, slack)).refusal).toBeNull();
    expect((await gate('get_thread', { channel: 'G0FIN', ts: '1.2' }, slack)).refusal).toBeNull();
    const refused = await gate('get_history', { channel: 'G0EXEC' }, slack);
    expect(refused.refusal?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
    expect(refused.refusal?.message).toContain('the person this session works for is not in it');
    expect(calls).toContain('view:user-1');
  });

  test("a DM is read only by a session of the person in it, not someone else's", async () => {
    const { slack } = deps();
    expect((await gate('get_history', { channel: 'D0WITHME' }, slack)).refusal).toBeNull();
    expect((await gate('get_history', { channel: 'D0WITHSAM' }, slack)).refusal?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
  });

  test('a session whose person has no Slack account here reads no private conversation, and is told how to link one', async () => {
    const { slack } = deps({ view: { ...VIEW, allowedIds: new Set(), hasPerson: false } });
    const g = await gate('get_history', { channel: 'G0FIN' }, slack);
    expect(g.refusal?.message).toContain('/kortix login');
  });

  test('when Slack cannot say what is private, a conversation read is refused, not guessed', async () => {
    const { slack } = deps({ view: null });
    expect((await gate('get_history', { channel: 'C0PUBLIC' }, slack)).refusal?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
  });

  test('an id of any other shape is refused', async () => {
    const { slack } = deps();
    for (const channel of ['#general', 'C0 PUBLIC', 42, undefined]) {
      expect((await gate('get_history', { channel }, slack)).refusal).not.toBeNull();
    }
  });
});

describe('reads decided on the answer', () => {
  test('list_channels keeps public channels and the private ones the person is in', async () => {
    const { slack } = deps();
    const res = await answer(await gate('list_channels', {}, slack), {
      ok: true,
      channels: [
        { id: 'C0PUBLIC', is_private: false },
        { id: 'G0FIN', is_private: true },
        { id: 'G0EXEC', is_private: true },
        { id: 'D0WITHSAM', is_im: true },
      ],
    });
    expect('data' in res && (res.data as { channels: Array<{ id: string }> }).channels.map((c) => c.id)).toEqual(['C0PUBLIC', 'G0FIN']);
  });

  test('channel_info: a public channel is directory data; a private one follows the person', async () => {
    const { slack } = deps();
    expect('data' in (await answer(await gate('channel_info', { channel: 'C0PUBLIC' }, slack), { ok: true, channel: { id: 'C0PUBLIC', is_private: false } }))).toBe(true);
    const refused = await answer(await gate('channel_info', { channel: 'G0EXEC' }, slack), { ok: true, channel: { id: 'G0EXEC', is_private: true } });
    expect('refusal' in refused && refused.refusal.reason).toBe(SLACK_PRIVATE_CONVERSATION);
  });

  test('file_info: a file in a public channel, or in a private one the person is in, is readable', async () => {
    const { slack } = deps();
    const file = (shares: Record<string, string[]>) => ({ ok: true, file: { id: 'F0SYNTH01', channels: [], groups: [], ims: [], ...shares } });
    expect('data' in (await answer(await gate('file_info', { file: 'F0SYNTH01' }, slack), file({ channels: ['C0PUBLIC'] })))).toBe(true);
    expect('data' in (await answer(await gate('file_info', { file: 'F0SYNTH01' }, slack), file({ groups: ['G0FIN'] })))).toBe(true);
    expect('refusal' in (await answer(await gate('file_info', { file: 'F0SYNTH01' }, slack), file({ groups: ['G0EXEC'] })))).toBe(true);
  });

  test('file_info: a file also shared in public keeps out the private conversations the person is not in', async () => {
    const { slack } = deps();
    const res = await answer(await gate('file_info', { file: 'F0SYNTH01' }, slack), {
      ok: true,
      file: { id: 'F0SYNTH01', channels: ['C0PUBLIC'], groups: ['G0FIN', 'G0EXEC'], ims: [], shares: { private: { G0FIN: [{ ts: '1.0' }], G0EXEC: [{ ts: '2.0' }] } } },
    });
    const file = 'data' in res ? (res.data as { file: { groups: string[]; shares: { private: Record<string, unknown> } } }).file : null;
    expect(file?.groups).toEqual(['G0FIN']);
    expect(Object.keys(file?.shares.private ?? {})).toEqual(['G0FIN']);
  });

  test('search_messages drops matches from private conversations the person is not in', async () => {
    const { slack } = deps();
    const res = await answer(await gate('search_messages', { query: 'q4' }, slack), {
      ok: true,
      messages: { matches: [{ channel: { id: 'C0PUBLIC' } }, { channel: { id: 'G0EXEC' } }, { channel: { id: 'G0FIN' } }] },
    });
    const kept = 'data' in res ? (res.data as { messages: { matches: Array<{ channel: { id: string } }> } }).messages.matches : [];
    expect(kept.map((m) => m.channel.id)).toEqual(['C0PUBLIC', 'G0FIN']);
  });
});

test('every Slack read action has a decision here', () => {
  const kinds = new Set<ChannelReadScope>(Object.values(CHANNEL_READ_SCOPES.slack));
  for (const kind of kinds) expect(['channel', 'thread', 'channel_meta', 'channel_list', 'file', 'workspace', 'directory', 'write']).toContain(kind);
});

describe('writes into private conversations', () => {
  const write = (channel: unknown) => slackPrivateWrite({ projectId: MINE, userId: 'user-1', channel }, deps().slack);

  test('a name or a malformed id is refused, as a read is: Slack would resolve it', async () => {
    for (const channel of ['secret-project', '#general', '', null, undefined]) {
      expect((await write(channel))?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
    }
  });

  test('a private channel the person is in, a public one and a DM are written; another private one is refused', async () => {
    expect(await write('G0FIN')).toBeNull();
    expect(await write('C0PUBLIC')).toBeNull();
    expect(await write('D0WITHSAM')).toBeNull();
    expect((await write('G0EXEC'))?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
  });
});
