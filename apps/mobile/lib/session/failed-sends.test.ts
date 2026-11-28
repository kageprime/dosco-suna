import { beforeEach, describe, expect, test } from 'bun:test';

import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, type SessionLogMessage, type SessionLogThread } from '@kortix/sdk';

import { localUriOf } from './optimistic-parts';
import {
  failedSendMessages,
  sendIdsFor,
  serverHeldSendIds,
  threadWithFailedSends,
  unsentFailedSends,
  useFailedSendStore,
  withFailed,
  withoutFailed,
  type FailedSend,
} from './failed-sends';

const send = { text: 'hello', options: { agent: 'kortix' } };

describe('failed sends', () => {
  beforeEach(() => useFailedSendStore.setState({ bySession: {} }));

  test('markFailed keeps the payload under its session and message', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    expect(useFailedSendStore.getState().bySession).toEqual({ s1: { msg_1: send } });
  });

  test('take returns the payload once, so a double tap retries once', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(send);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toBeUndefined();
    expect(useFailedSendStore.getState().bySession).toEqual({});
  });

  test('take leaves the other failed sends of the session', () => {
    useFailedSendStore.getState().markFailed('s1', 'msg_1', send);
    useFailedSendStore.getState().markFailed('s1', 'msg_2', { text: 'two', options: {} });
    useFailedSendStore.getState().take('s1', 'msg_1');
    expect(Object.keys(useFailedSendStore.getState().bySession.s1!)).toEqual(['msg_2']);
  });

  test('withoutFailed on a missing entry returns the same object', () => {
    const state = withFailed({}, 's1', 'msg_1', send);
    expect(withoutFailed(state, 's1', 'nope')).toBe(state);
    expect(withoutFailed(state, 's2', 'msg_1')).toBe(state);
  });

  test('markFailed keeps fileParts and localFiles and take returns them', () => {
    const withFiles = {
      text: 'hi',
      options: {},
      fileParts: [{ type: 'file' as const, attachment_id: 'a1', mime: 'image/jpeg', filename: 'photo_1.jpg' }],
      localFiles: [{ uri: 'file:///cache/photo_1.jpg', name: 'photo_1.jpg', mimeType: 'image/jpeg', isImage: true }],
    };
    useFailedSendStore.getState().markFailed('s1', 'msg_1', withFiles);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(withFiles);
  });

  test('markFailed keeps the send ids and take returns them', () => {
    const withIds = { text: 'hi', options: {}, clientMessageId: 'c-1', messageId: 'msg_1' };
    useFailedSendStore.getState().markFailed('s1', 'msg_1', withIds);
    expect(useFailedSendStore.getState().take('s1', 'msg_1')).toEqual(withIds);
  });
});

describe('sendIdsFor', () => {
  const mint = () => ({ clientMessageId: 'fresh-client', messageId: 'msg_fresh' });

  test('a first send mints new ids', () => {
    expect(sendIdsFor(undefined, mint)).toEqual({ clientMessageId: 'fresh-client', messageId: 'msg_fresh' });
  });

  test('a retry reuses both ids, so the server dedupes a prompt that already landed', () => {
    expect(sendIdsFor({ clientMessageId: 'c-1', messageId: 'msg_1' }, mint)).toEqual({
      clientMessageId: 'c-1',
      messageId: 'msg_1',
    });
  });

  test('a retry with only one id kept mints the other', () => {
    expect(sendIdsFor({ messageId: 'msg_1' }, mint)).toEqual({ clientMessageId: 'fresh-client', messageId: 'msg_1' });
  });
});

describe('failedSendMessages', () => {
  test('each failed send is a user message under its id, oldest first, with its text and picked files', () => {
    const messages = failedSendMessages('ses_1', {
      msg_b: { text: 'second', options: {}, failedAtMs: 200 },
      msg_a: {
        text: 'first',
        options: {},
        failedAtMs: 100,
        localFiles: [{ uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', isImage: true } as never],
      },
    });
    expect(messages.map((m) => m.message_id)).toEqual(['msg_a', 'msg_b']);
    expect(messages[0]).toMatchObject({ role: 'user', kind: 'turn', thread_id: 'ses_1', created_at: new Date(100).toISOString() });
    expect(messages[0].blocks).toMatchObject([
      { type: 'text', text: 'first' },
      { type: 'attachment', name: 'a.png', mime: 'image/png' },
    ]);
    // The bubble finds the picked file's thumbnail by the attachment's id.
    expect(localUriOf(messages[0].blocks[1].id)).toBe('file:///a.png');
    expect(messages[1].blocks).toMatchObject([{ type: 'text', text: 'second' }]);
  });

  test('no failed send, no message', () => {
    expect(failedSendMessages('ses_1', {})).toEqual([]);
  });
});

// A thread as the session log serves it: synthetic ids, server times in ms.
function logMessage(id: string, role: 'user' | 'assistant', atMs: number, seq: number, replyTo?: string): SessionLogMessage {
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'ses_1', seq, role, kind: 'turn',
    status: 'complete', in_context: true, origin: role === 'user' ? 'prompt' : 'model', model: null, usage: null,
    finish: null, error: null, created_at: new Date(atMs).toISOString(), completed_at: null,
    producer: { harness: 'pi', harness_version: '', adapter_version: '1' },
    ...(replyTo ? { reply_to: replyTo } : {}),
    blocks: [{ type: 'text', id: `${id}_t`, text: id }],
  } as SessionLogMessage;
}

function logThread(messages: SessionLogMessage[]): SessionLogThread {
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'ses_1', parent_thread_id: null, spawned_by: null,
    agent: null, title: null, created_at: new Date(0).toISOString(), messages,
  } as SessionLogThread;
}

// Two answered turns: "first" at 10 s, "third" at 30 s.
const twoTurns = () =>
  logThread([
    logMessage('msg_first', 'user', 10_000, 2),
    logMessage('msg_first_reply', 'assistant', 11_000, 3, 'msg_first'),
    logMessage('msg_third', 'user', 30_000, 5),
    logMessage('msg_third_reply', 'assistant', 31_000, 6, 'msg_third'),
  ]);

const failedAt = (atMs: number, extra: Partial<FailedSend> = {}): FailedSend => ({
  text: 'not sent',
  options: {},
  failedAtMs: atMs,
  ...extra,
});

describe('threadWithFailedSends', () => {
  test('a failed send stays where the user sent it, not under every later turn', () => {
    const thread = threadWithFailedSends(twoTurns(), { msg_second: failedAt(20_000) });
    const turns = sessionLogTurns(thread, { busy: false });
    expect(turns.map((t) => t.user.message_id)).toEqual(['msg_first', 'msg_second', 'msg_third']);
  });

  test('a failed send keeps no reply of the turn before it', () => {
    const thread = threadWithFailedSends(twoTurns(), { msg_second: failedAt(20_000) });
    const turns = sessionLogTurns(thread, { busy: false });
    expect(turns.map((t) => t.assistant.map((m) => m.message_id))).toEqual([['msg_first_reply'], [], ['msg_third_reply']]);
  });

  test('a failed send after the last turn is the last turn', () => {
    const thread = threadWithFailedSends(twoTurns(), { msg_last: failedAt(40_000) });
    expect(sessionLogTurns(thread, { busy: false }).map((t) => t.user.message_id)).toEqual(['msg_first', 'msg_third', 'msg_last']);
  });

  test('two failed sends keep their order, each between its neighbours', () => {
    const thread = threadWithFailedSends(twoTurns(), { msg_b: failedAt(35_000), msg_a: failedAt(5_000) });
    expect(sessionLogTurns(thread, { busy: false }).map((t) => t.user.message_id)).toEqual(['msg_a', 'msg_first', 'msg_third', 'msg_b']);
  });

  test("a failed copy takes the seq of the message before it, so the thread's seq never falls", () => {
    const thread = threadWithFailedSends(twoTurns(), { msg_second: failedAt(20_000), msg_a: failedAt(5_000) });
    const seqs = thread.messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(Math.max(...seqs)).toBe(6);
  });

  test('no failed send keeps the same thread object', () => {
    const thread = twoTurns();
    expect(threadWithFailedSends(thread, {})).toBe(thread);
  });
});

describe('serverHeldSendIds and unsentFailedSends', () => {
  const failed = {
    msg_answered: failedAt(20_000, { clientMessageId: 'c_answered', messageId: 'msg_answered' }),
    msg_queued: failedAt(21_000, { clientMessageId: 'c_queued', messageId: 'msg_queued' }),
    msg_sent: failedAt(22_000, { clientMessageId: 'c_sent', messageId: 'msg_sent' }),
    msg_reminted: failedAt(23_000, { clientMessageId: 'c_reminted', messageId: 'msg_reminted' }),
    msg_lost: failedAt(24_000, { clientMessageId: 'c_lost', messageId: 'msg_lost' }),
  };

  test('a send the server holds is not "Not sent": its log message, inbox row or sent entry proves it arrived', () => {
    const held = serverHeldSendIds({
      // The request reached the server and only its answer was lost: the log holds the message.
      messages: [logMessage('msg_answered', 'user', 20_000, 7)],
      // Still in the inbox (queued, delivering, or failed on the server: "Up next" shows it).
      prompts: [{ client_message_id: 'c_queued', message_id: 'msg_queued_server' }],
      // Accepted by the runtime, not in the log yet; one re-minted, listed under its wire id.
      sent: [{ message_id: 'msg_sent' }, { message_id: 'msg_new_id', wire_message_id: 'msg_reminted' }],
    });
    expect(Object.keys(unsentFailedSends(failed, held))).toEqual(['msg_lost']);
  });

  test('nothing held keeps every failed send, as the same object', () => {
    const none = serverHeldSendIds({ messages: [], prompts: [], sent: [] });
    expect(unsentFailedSends(failed, none)).toBe(failed);
  });
});
