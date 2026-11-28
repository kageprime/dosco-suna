import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from './attachments';
import {
  firstPromptSeed,
  forgetSeededPrompt,
  rememberSeededPrompt,
  SEED_BUSY_WATCHDOG_MS,
  seedEchoed,
  seededPromptOf,
  seedUndelivered,
} from './first-prompt-seed';
import { mintWireMessageId } from './wire-message-id';

const ROOT = 'ses_runtime_root';
const NOW = 1755500000000;
const PHOTO: AttachedFile = {
  uri: 'file:///cache/photo_1.jpg',
  name: 'photo_1.jpg',
  mimeType: 'image/jpeg',
  isImage: true,
};

function seed(i: Partial<Parameters<typeof firstPromptSeed>[0]> = {}) {
  return firstPromptSeed({
    text: 'hello',
    files: [],
    runtimeSessionId: ROOT,
    knownMessageIds: [],
    nowMs: NOW,
    ...i,
  });
}



describe('firstPromptSeed', () => {
  test('returns null for empty text and no files', () => {
    expect(seed({ text: '   ', files: [] })).toBeNull();
  });

  test('returns null when the store already holds messages for the root', () => {
    expect(seed({ knownMessageIds: ['msg_8bbf25e40000AAAAAAAAAAAAAA'] })).toBeNull();
  });

  test('text seeds one user message under the runtime root with one prt_ text part', () => {
    const result = seed({ text: 'hello' })!;
    expect(result.info.role).toBe('user');
    expect(result.info.sessionID).toBe(ROOT);
    expect(result.info.time.created).toBe(NOW);
    expect(result.info.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(result.parts[0].id.startsWith('prt_')).toBe(true);
  });

  test('image only seeds one file part with the local uri', () => {
    const result = seed({ text: '', files: [PHOTO] })!;
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0] as { type: string; id: string; localUri?: string; mime?: string; filename?: string };
    expect(part.type).toBe('file');
    expect(part.localUri).toBe('file:///cache/photo_1.jpg');
    expect(part.mime).toBe('image/jpeg');
    expect(part.filename).toBe('photo_1.jpg');
    expect(part.id.startsWith('prt_')).toBe(true);
  });

  test('text and two files give three parts with distinct ids, text first', () => {
    const result = seed({ text: 'look', files: [PHOTO, { ...PHOTO, uri: 'file:///cache/b.pdf', name: 'b.pdf' }] })!;
    expect(result.parts.map((p) => p.type)).toEqual(['text', 'file', 'file']);
    expect(new Set(result.parts.map((p) => p.id)).size).toBe(3);
  });

  test('seed id sorts after known ids', () => {
    // A non-empty `knownMessageIds` returns null (the store already holds the
    // root), so "known" here is an id minted earlier elsewhere, 1 s before.
    const known = mintWireMessageId({ nowMs: NOW - 1_000, knownMessageIds: [] });
    const result = seed({ nowMs: NOW })!;
    expect(result.info.id > known).toBe(true);
  });
});

describe('seedUndelivered', () => {
  const SEED_ID = 'msg_seed';

  test('seedUndelivered is true for [seed] and [] and false once an assistant or real user message exists', () => {
    expect(seedUndelivered([SEED_ID], SEED_ID)).toBe(true);
    expect(seedUndelivered([], SEED_ID)).toBe(true);
    expect(seedUndelivered([SEED_ID, 'msg_a'], SEED_ID)).toBe(false);
    expect(seedUndelivered(['msg_real'], SEED_ID)).toBe(false);
  });

  test('the watchdog waits 30 s', () => {
    expect(SEED_BUSY_WATCHDOG_MS).toBe(30_000);
  });
});

describe('seedEchoed', () => {
  const SEED = { id: 'msg_seed', text: 'research the company' };
  type Msg = Parameters<typeof seedEchoed>[0] extends readonly (infer M)[] | undefined ? M : never;
  const user = (message_id: string, text: string, kind: Msg['kind'] = 'turn') =>
    ({ message_id, role: 'user', kind, blocks: [{ type: 'text', id: `${message_id}-t`, text }] }) as Msg;
  const reply = (message_id: string) =>
    ({ message_id, role: 'assistant', kind: 'turn', blocks: [{ type: 'text', id: `${message_id}-t`, text: 'ok' }] }) as Msg;
  const seedRow = user(SEED.id, SEED.text);
  const onlySeedOptimistic = (id: string) => id === SEED.id;

  test('the seed alone is not echoed', () => {
    expect(seedEchoed([seedRow], SEED, onlySeedOptimistic)).toBe(false);
  });

  test('the log holding the prompt under the server id echoes the seed', () => {
    // The thread a v2 session renders: the log's prompt, its reply, and the seed the log never names.
    const thread = [user('msg_server', SEED.text), reply('msg_reply'), seedRow];
    expect(seedEchoed(thread, SEED, onlySeedOptimistic)).toBe(true);
  });

  test('a queued follow-up that reaches the log first does not echo the seed', () => {
    const thread = [seedRow, user('msg_followup', 'and their funding')];
    expect(seedEchoed(thread, SEED, onlySeedOptimistic)).toBe(false);
    expect(seedEchoed([...thread, user('msg_server', SEED.text)], SEED, onlySeedOptimistic)).toBe(true);
  });

  test('another optimistic send from this device does not echo the seed', () => {
    const thread = [seedRow, user('msg_next', SEED.text)];
    expect(seedEchoed(thread, SEED, (id) => id === SEED.id || id === 'msg_next')).toBe(false);
  });

  test('a reply alone or a context message does not echo the seed', () => {
    expect(seedEchoed([seedRow, reply('msg_reply')], SEED, onlySeedOptimistic)).toBe(false);
    expect(seedEchoed([user('msg_ctx', SEED.text, 'context'), seedRow], SEED, onlySeedOptimistic)).toBe(false);
  });

  test('a follow-up that contains the seed text does not echo it', () => {
    const seed = { id: SEED.id, text: 'ship' };
    expect(seedEchoed([user(SEED.id, 'ship'), user('msg_followup', 'dont ship yet')], seed, onlySeedOptimistic)).toBe(false);
  });

  test('a files-only seed is echoed by a user turn without text, not by a text follow-up', () => {
    const filesOnly = { id: SEED.id, text: '' };
    const fileTurn = {
      message_id: 'msg_server',
      role: 'user',
      kind: 'turn',
      blocks: [{ type: 'attachment', id: 'att_1', name: 'a.png', mime: 'image/png', url: 'https://x/a.png' }],
    } as unknown as Msg;
    const synthetic = {
      message_id: 'msg_synthetic',
      role: 'user',
      kind: 'turn',
      blocks: [{ type: 'text', id: 'msg_synthetic-t', text: 'continue', synthetic: true }],
    } as unknown as Msg;
    expect(seedEchoed([user(SEED.id, ''), user('msg_followup', 'wait')], filesOnly, onlySeedOptimistic)).toBe(false);
    expect(seedEchoed([synthetic, user(SEED.id, '')], filesOnly, onlySeedOptimistic)).toBe(false);
    expect(seedEchoed([fileTurn, user(SEED.id, '')], filesOnly, onlySeedOptimistic)).toBe(true);
  });

  test('an upload the runtime wrote as a <file> tag still matches the seed text', () => {
    const tag = '<file path="/workspace/uploads/.kortix-inbox/a.png" mime="image/png" filename="a.png">\nThis file has been uploaded and is available at the path above.\n</file>';
    expect(seedEchoed([user('msg_server', `${SEED.text}\n\n${tag}`), user(SEED.id, SEED.text)], SEED, onlySeedOptimistic)).toBe(true);
    expect(seedEchoed([user('msg_server', tag), user(SEED.id, '')], { id: SEED.id, text: '' }, onlySeedOptimistic)).toBe(true);
  });

  test('the echo matches after the server repairs a NUL or a lone surrogate, and around whitespace', () => {
    const seed = { id: SEED.id, text: 'a\u0000b \uD83D c' };
    const echo = user('msg_server', '  a\uFFFDb \uFFFD c\n');
    expect(seedEchoed([echo, user(SEED.id, seed.text)], seed, onlySeedOptimistic)).toBe(true);
  });

  test('no thread is not echoed', () => {
    expect(seedEchoed(undefined, SEED, onlySeedOptimistic)).toBe(false);
  });
});

describe('seeded prompt registry', () => {
  test('remembers the seed per runtime root until it is forgotten', () => {
    expect(seededPromptOf('root_a')).toBeUndefined();
    rememberSeededPrompt('root_a', { id: 'msg_a', text: 'hi' });
    expect(seededPromptOf('root_a')).toEqual({ id: 'msg_a', text: 'hi' });
    expect(seededPromptOf('root_b')).toBeUndefined();
    forgetSeededPrompt('root_a');
    expect(seededPromptOf('root_a')).toBeUndefined();
  });
});
