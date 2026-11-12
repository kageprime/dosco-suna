/**
 * The decisions of the Slack and Telegram write confinement. Slack: one Slack
 * workspace runs in one Kortix workspace, so the link decides (a fake link
 * state here; the rows behind the real one are proven on PostgreSQL in
 * `__tests__/integration-channel-write-scope.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { CHANNEL_READ_SCOPES, CONVERSATION_NOT_IN_PROJECT } from './channel-read-scope';
import {
  SLACK_WRITE_TARGETS,
  type SlackLinkState,
  TELEGRAM_READS,
  gateChannelWrite,
  slackWriteRefusal,
  telegramReplyRefusal,
  telegramWriteRefusal,
} from './channel-write-scope';
import { SLACK_NOT_LINKED, SLACK_PRIVATE_CONVERSATION, type SlackReadDeps } from './slack-visibility';
import { channelCatalog } from './channels';

const MINE = 'project-mine';

function linkOf(state: SlackLinkState) {
  const asked: string[] = [];
  return {
    asked,
    linkState: async (projectId: string) => {
      asked.push(projectId);
      return state;
    },
  };
}

/** The linked Slack workspace: G0PRIVATE1 is private and the person is in it, G0EXEC private and they are not. */
const READS: SlackReadDeps = {
  link: async () => ({ teamId: 'T0SYNTH01' }),
  view: async () => ({ privateIds: new Set(['G0PRIVATE1', 'G0EXEC', 'D0WITHSAM']), allowedIds: new Set(['G0PRIVATE1']), hasPerson: true }),
};

async function write(actionPath: string, args: Record<string, unknown>, state: SlackLinkState = 'linked') {
  return (
    await gateChannelWrite({ projectId: MINE, userId: 'user-1', platform: 'slack', actionPath, args }, linkOf(state).linkState, READS)
  ).refusal;
}

describe('every Slack write is classified', () => {
  test('the write table covers exactly the catalog actions that are not reads', () => {
    const writes = channelCatalog('slack')
      .filter((a) => a.risk !== 'read')
      .map((a) => a.path)
      .sort();
    expect(Object.keys(SLACK_WRITE_TARGETS).sort()).toEqual(writes);
    expect(writes).toEqual(
      Object.entries(CHANNEL_READ_SCOPES.slack)
        .filter(([, scope]) => scope === 'write')
        .map(([path]) => path)
        .sort(),
    );
  });

  test('reads and other platforms are left to their own gates', async () => {
    expect(await write('get_history', { channel: 'C0ANY00001' }, 'not_linked')).toBeNull();
    expect(
      (await gateChannelWrite({ projectId: MINE, platform: 'email', actionPath: 'send_message', args: {} }, linkOf('not_linked').linkState, READS))
        .refusal,
    ).toBeNull();
  });
});

describe('Slack writes follow the link', () => {
  test('the Kortix workspace holding the Slack workspace posts, replies, edits, reacts and joins anywhere its bot may', async () => {
    expect(await write('send_message', { channel: 'C0ANY00001', text: 'hi' })).toBeNull();
    expect(await write('send_message', { channel: 'U0PERSON01', text: 'hi' })).toBeNull();
    expect(await write('send_message', { channel: 'G0PRIVATE1', thread_ts: '100.000100', text: 'hi' })).toBeNull();
    expect(await write('update_message', { channel: 'C0ANY00001', ts: '100.000100', text: 'edit' })).toBeNull();
    expect(await write('add_reaction', { channel: 'C0ANY00001', timestamp: '100.000100', name: 'eyes' })).toBeNull();
    expect(await write('join_channel', { channel: 'C0ANY00001' })).toBeNull();
  });

  test('private content follows the person: no post, reaction or join in a private channel the person is not in; DMs stay open', async () => {
    for (const [action, args] of [
      ['send_message', { channel: 'G0EXEC', text: 'hi' }],
      ['add_reaction', { channel: 'G0EXEC', timestamp: '100.000100', name: 'eyes' }],
      ['join_channel', { channel: 'G0EXEC' }],
    ] as const) {
      expect((await write(action, args))?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
    }
    expect(await write('send_message', { channel: 'G0PRIVATE1', text: 'hi' })).toBeNull();
    // A DM is to one person: the agent asks a teammate there.
    expect(await write('send_message', { channel: 'D0WITHSAM', text: 'can you approve?' })).toBeNull();
    expect(await write('send_message', { channel: 'U0SOMEONE1', text: 'can you approve?' })).toBeNull();
  });

  test('a session with no person posts only in public channels and DMs', async () => {
    const noPerson: SlackReadDeps = { ...READS, view: async () => ({ privateIds: new Set(['G0PRIVATE1']), allowedIds: new Set(), hasPerson: false }) };
    const gate = (channel: string) =>
      gateChannelWrite({ projectId: MINE, userId: null, platform: 'slack', actionPath: 'send_message', args: { channel, text: 'hi' } }, linkOf('linked').linkState, noPerson);
    expect((await gate('G0PRIVATE1')).refusal?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
    expect((await gate('C0PUBLIC01')).refusal).toBeNull();
  });

  test('when Slack does not answer what is private, a write is refused as a read is; with no Slack token nothing is reachable', async () => {
    const gate = (reads: SlackReadDeps) =>
      gateChannelWrite(
        { projectId: MINE, userId: 'user-1', platform: 'slack', actionPath: 'send_message', args: { channel: 'C0ANY00001', text: 'hi' } },
        linkOf('linked').linkState,
        reads,
      );
    expect((await gate({ ...READS, view: async () => null })).refusal?.reason).toBe(SLACK_PRIVATE_CONVERSATION);
    expect((await gate({ ...READS, view: async () => 'no_slack' })).refusal).toBeNull();
  });

  test('a Kortix workspace that does not hold the Slack workspace writes nothing', async () => {
    for (const [action, args] of [
      ['send_message', { channel: 'C0ANY00001', text: 'hi' }],
      ['join_channel', { channel: 'C0ANY00001' }],
      ['delete_message', { channel: 'C0ANY00001', ts: '100.000100' }],
    ] as const) {
      const refusal = await write(action, args, 'not_linked');
      expect(refusal?.reason).toBe(SLACK_NOT_LINKED);
      expect(refusal?.message).toContain('another Kortix workspace is connected to it');
    }
  });

  test('edits, deletes and reactions need the message ts', async () => {
    for (const [action, arg] of [
      ['update_message', 'ts'],
      ['delete_message', 'ts'],
      ['add_reaction', 'timestamp'],
      ['remove_reaction', 'timestamp'],
    ] as const) {
      const refusal = await write(action, { channel: 'C0ANY00001' });
      expect(refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
      expect(refusal?.message).toBe(`\`${arg}\` is required.`);
    }
  });
});

describe('ids and installs', () => {
  test('a channel name, a lowercase id or a padded id is refused before the link is read: Slack resolves names', async () => {
    for (const channel of ['general', '#general', 'c0other001', ' C0OTHER001', 'C0OTHER001\n', ['C0MINE0001'], 42, undefined]) {
      const { linkState, asked } = linkOf('linked');
      const refusal = await slackWriteRefusal(MINE, { channel }, linkState);
      expect(refusal?.kind).toBe('invalid');
      expect(refusal?.message).toContain('`channel` must be one Slack conversation or user id');
      expect(asked).toEqual([]);
    }
  });

  test('a malformed thread_ts is refused; an empty one means no thread', async () => {
    expect((await write('send_message', { channel: 'C0MINE0001', thread_ts: 1700000000.0001 }))?.message).toBe(
      '`thread_ts` must be one Slack message timestamp, for example 1700000000.000100.',
    );
    expect((await write('send_message', { channel: 'C0MINE0001', thread_ts: 'latest' }))?.message).toContain('`thread_ts`');
    expect(await write('send_message', { channel: 'C0MINE0001', thread_ts: '', text: 'hi' })).toBeNull();
  });

  test('the refusal kinds the routes map to statuses', async () => {
    const kind = async (state: SlackLinkState, channel = 'C0ANY00001') =>
      (await slackWriteRefusal(MINE, { channel }, linkOf(state).linkState))?.kind ?? null;
    expect(await kind('linked', 'nope')).toBe('invalid');
    expect(await kind('no_install')).toBe('install');
    expect(await kind('not_linked')).toBe('not_linked');
    expect(await kind('linked')).toBeNull();
  });
});

describe('where a post landed', () => {
  const gate = (actionPath: string, args: Record<string, unknown>) =>
    gateChannelWrite({ projectId: MINE, userId: 'user-1', platform: 'slack', actionPath, args }, linkOf('linked').linkState, READS);

  test('a post that landed in the checked conversation, or a DM for a user id, stands', async () => {
    expect((await gate('send_message', { channel: 'C0NOBODY01', text: 'hi' })).misfire({ ok: true, channel: 'C0NOBODY01', ts: '1.2' })).toBeNull();
    expect((await gate('send_message', { channel: 'U0PERSON01', text: 'hi' })).misfire({ ok: true, channel: 'D0PERSON01', ts: '1.2' })).toBeNull();
    expect((await gate('send_message', { channel: 'U0PERSON01', text: 'hi' })).misfire({ ok: true, channel: 'U0PERSON01', ts: '1.2' })).toBeNull();
  });

  test('a post Slack delivered elsewhere (a resolved name) is refused, with the call that takes it back', async () => {
    const byName = await gate('send_message', { channel: 'GENERAL', text: 'hi' });
    expect(byName.refusal).toBeNull();
    expect(byName.misfire({ ok: true, channel: 'C0OTHER001', ts: '1700000900.000900' })).toEqual({
      refusal: {
        reason: CONVERSATION_NOT_IN_PROJECT,
        message:
          'Slack posted the message to C0OTHER001, not to GENERAL, the conversation that was checked. Address a conversation by its id.',
      },
      undo: { path: '/chat.delete', args: { channel: 'C0OTHER001', ts: '1700000900.000900' } },
    });
    // "User id" that Slack read as a channel name: it landed in a channel, not a DM.
    expect((await gate('send_message', { channel: 'UIUX', text: 'hi' })).misfire({ ok: true, channel: 'C0UIUX0001', ts: '1.2' })?.undo)
      .toEqual({ path: '/chat.delete', args: { channel: 'C0UIUX0001', ts: '1.2' } });
    // An answer that names no conversation cannot be trusted or taken back.
    expect((await gate('send_message', { channel: 'C0NOBODY01', text: 'hi' })).misfire({ ok: true })?.undo).toBeNull();
  });

  test('only a post is checked where it landed: every other write takes an id', async () => {
    const reaction = await gate('add_reaction', { channel: 'C0ANY00001', timestamp: '1.2', name: 'eyes' });
    expect(reaction.misfire({ ok: true, channel: 'C0ELSEWHERE' })).toBeNull();
  });
});


describe('Telegram writes', () => {
  const OTHER_CHAT = 'This session answers Telegram chat 111222333 only. It does not send to, edit or delete messages in other chats.';

  test('every Telegram action but the two reads is a write into the chat its `chat_id` names', () => {
    const writes = channelCatalog('telegram').filter((a) => !TELEGRAM_READS.has(a.path));
    expect(writes.map((a) => a.path).sort()).toEqual(['delete_message', 'edit_message_text', 'send_chat_action', 'send_message']);
    for (const action of writes) {
      expect((action.inputSchema as { required: string[] }).required).toContain('chat_id');
    }
    expect([...TELEGRAM_READS].sort()).toEqual(['get_chat', 'get_me']);
  });

  test('a session no Telegram chat started or is bound to writes to any chat of the bot', () => {
    for (const chatId of [111222333, 444555666, '-1001234567890', '@any_channel']) {
      expect(telegramWriteRefusal(chatId, null)).toBeNull();
    }
  });

  test("a chat's session writes to its own chat, as a number or a string", () => {
    expect(telegramWriteRefusal(111222333, ['111222333'])).toBeNull();
    expect(telegramWriteRefusal('111222333', ['111222333'])).toBeNull();
    expect(telegramWriteRefusal(-1001234567890, ['-1001234567890'])).toBeNull();
  });

  test('another chat, a channel username and a malformed id are refused', () => {
    for (const chatId of [444555666, '444555666', '@other_channel', '111222333 ', '0111222333', 'abc', 111222333.5, '', undefined, null, [111222333]]) {
      expect(telegramWriteRefusal(chatId, ['111222333'])).toBe(OTHER_CHAT);
    }
  });

  test('a session bound to several chats writes to each of them and to no other', () => {
    expect(telegramWriteRefusal(111222333, ['111222333', '-100777888'])).toBeNull();
    expect(telegramWriteRefusal(-100777888, ['111222333', '-100777888'])).toBeNull();
    expect(telegramWriteRefusal(444555666, ['111222333', '-100777888'])).toBe(
      'This session answers Telegram chat 111222333 or -100777888 only. It does not send to, edit or delete messages in other chats.',
    );
  });

  test('a reply quotes a message of one of the chats the session answers, given as an object', () => {
    const own = ['111222333'];
    expect(telegramReplyRefusal(undefined, own)).toBeNull();
    expect(telegramReplyRefusal({ message_id: 5 }, own)).toBeNull();
    expect(telegramReplyRefusal({ chat_id: 111222333, message_id: 5 }, own)).toBeNull();
    expect(telegramReplyRefusal({ chat_id: 444555666, message_id: 5 }, own)).toBe(OTHER_CHAT);
    expect(telegramReplyRefusal({ chat_id: '@other_channel', message_id: 5 }, own)).toBe(OTHER_CHAT);
    for (const notAnObject of ['{"chat_id":444555666,"message_id":5}', null, 5, [5]]) {
      expect(telegramReplyRefusal(notAnObject, own)).toBe('`reply_parameters` must be an object, for example {"message_id": 5}.');
    }
    // A session no chat started quotes any chat, in any shape Telegram reads.
    expect(telegramReplyRefusal({ chat_id: 444555666, message_id: 5 }, null)).toBeNull();
    expect(telegramReplyRefusal('{"chat_id":444555666,"message_id":5}', null)).toBeNull();
  });

  test('a confined session whose chat is not on record writes nowhere', () => {
    expect(telegramWriteRefusal(111222333, [])).toBe(
      "This session's Telegram chat is not on record, so it writes to no chat. It does not send to, edit or delete messages in other chats.",
    );
  });
});
