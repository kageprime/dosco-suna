import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KeyValueStorage } from '../cache/persisted-query-cache';
import type { SessionLogPage } from '../session-log/source';
import type { SessionLog, SessionLogMessage } from '../session-log/types';
import { createSavedCopyStore } from './saved-copy-store';

/**
 * Opening a session painted nothing until the control plane answered: skeleton
 * rows for 0.3-2.3 s on every cold open, and the whole reload when the backend
 * was slow. This store keeps the newest session-log page (`GET …/log`) of each
 * session the user opened, so the next open paints it in the first frame and the
 * fresh page reconciles into it by message id.
 */

const T0 = Date.parse('2026-10-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const golden: SessionLog = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
);

function page(overrides: Partial<SessionLogPage> = {}): SessionLogPage {
  const { threads, ...session } = structuredClone(golden);
  return {
    session,
    generation: 1,
    threads: threads.map(({ messages: _messages, ...head }) => head),
    thread_id: threads[0]!.thread_id,
    messages: threads[0]!.messages,
    has_more: false,
    ...overrides,
  };
}

/** `count` complete assistant messages of `chars` text each, on the golden root thread. */
function messages(count: number, chars: number): SessionLogMessage[] {
  const template = page().messages.find((message) => message.role === 'assistant')!;
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(template),
    message_id: `msg_${index + 1}`,
    seq: index + 1,
    status: 'complete',
    blocks: [{ id: `blk_${index + 1}`, type: 'text', text: 'x'.repeat(chars) }],
  }));
}

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function asyncStorage(inner = memoryStorage()): KeyValueStorage {
  return {
    getItem: async (key) => inner.getItem(key),
    setItem: async (key, value) => inner.setItem(key, value),
    removeItem: async (key) => inner.removeItem(key),
  };
}

function store(storage: KeyValueStorage, overrides: Record<string, unknown> = {}) {
  let now = T0;
  const instance = createSavedCopyStore({ storage, userId: 'user-a', now: () => now, ...overrides });
  return { instance, advance: (ms: number) => (now += ms) };
}

describe('a saved copy paints the next open', () => {
  test('reads back the page it wrote, synchronously from synchronous storage', async () => {
    const { instance } = store(memoryStorage());
    await instance.write('p1', 's1', page());

    const read = instance.read('p1', 's1');
    expect(read).not.toBeInstanceOf(Promise);
    expect(read).toEqual(page());
  });

  test('reads back through a promise from asynchronous storage', async () => {
    const { instance } = store(asyncStorage());
    await instance.write('p1', 's1', page());

    const read = instance.read('p1', 's1');
    expect(read).toBeInstanceOf(Promise);
    expect((await read)?.thread_id).toBe(page().thread_id);
  });

  test('an unknown session reads null', () => {
    const { instance } = store(memoryStorage());
    expect(instance.read('p1', 'missing')).toBeNull();
  });

  test('a copy lives under `<namespace>.log:<user>:<project>/<session>`', async () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    await instance.write('p1', 's1', page());

    expect(instance.keyFor('p1', 's1')).toBe('kortix.saved-copy.log:user-a:p1/s1');
    expect([...storage.data.keys()].sort()).toEqual(['kortix.saved-copy.log:user-a:index', 'kortix.saved-copy.log:user-a:p1/s1']);
  });
});

describe('only a valid, non-empty page is kept', () => {
  test.each([
    ['empty', { messages: [] }],
    ['invalid', { messages: [{ message_id: 'msg_x', seq: 'x' }] as unknown as SessionLogMessage[] }],
  ])('%s: not kept, and it replaces an older copy', async (_label, overrides) => {
    const { instance } = store(memoryStorage());
    await instance.write('p1', 's1', page());
    await instance.write('p1', 's1', page(overrides as Partial<SessionLogPage>));

    expect(instance.read('p1', 's1')).toBeNull();
  });

  test('a stored page that fails validation reads null and is removed', async () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    await instance.write('p1', 's1', page());
    const key = instance.keyFor('p1', 's1');
    const stored = JSON.parse(storage.data.get(key)!);
    stored.e.messages[0].seq = 'x';
    storage.data.set(key, JSON.stringify(stored));

    expect(instance.read('p1', 's1')).toBeNull();
    expect(storage.data.has(key)).toBe(false);
  });

  test('a page whose newest message alone exceeds the per-session bound is not kept', async () => {
    const { instance } = store(memoryStorage(), { maxEnvelopeBytes: 200 });
    await instance.write('p1', 's1', page());
    expect(instance.read('p1', 's1')).toBeNull();
  });
});

describe('an oversized page keeps its newest messages', () => {
  test('keeps the newest messages that fit, and says older ones exist', async () => {
    const full = page({ messages: messages(5, 1_000) });
    const bound = JSON.stringify({ ...full, messages: full.messages.slice(3) }).length + 200;
    const { instance } = store(memoryStorage(), { maxEnvelopeBytes: bound });
    await instance.write('p1', 's1', full);

    const read = instance.read('p1', 's1') as SessionLogPage;
    expect(read.messages.map((message) => message.message_id)).toEqual(['msg_4', 'msg_5']);
    // The reader pages older messages from the first kept one's `seq`.
    expect(read.has_more).toBe(true);
    expect(read.thread_id).toBe(full.thread_id);
  });

  test('a page within the bound is kept whole', async () => {
    const { instance } = store(memoryStorage(), { maxEnvelopeBytes: 50_000 });
    await instance.write('p1', 's1', page({ messages: messages(5, 1_000) }));

    const read = instance.read('p1', 's1') as SessionLogPage;
    expect(read.messages).toHaveLength(5);
    expect(read.has_more).toBe(false);
  });

  test('what it keeps is what it counts against the total bound', async () => {
    const storage = memoryStorage();
    const full = page({ messages: messages(5, 1_000) });
    const bound = JSON.stringify({ ...full, messages: full.messages.slice(3) }).length + 200;
    const { instance } = store(storage, { maxEnvelopeBytes: bound });
    await instance.write('p1', 's1', full);

    const stored = storage.data.get(instance.keyFor('p1', 's1'))!;
    expect(stored.length).toBeLessThanOrEqual(bound);
    const index = JSON.parse(storage.data.get('kortix.saved-copy.log:user-a:index')!);
    expect(index.entries[0].b).toBe(stored.length);
  });
});

describe('bounded', () => {
  test('keeps the most recently used sessions when over the session count', async () => {
    const { instance, advance } = store(memoryStorage(), { maxSessions: 2 });
    await instance.write('p1', 'a', page());
    advance(1_000);
    await instance.write('p1', 'b', page());
    advance(1_000);
    instance.read('p1', 'a');
    advance(1_000);
    await instance.write('p1', 'c', page());

    expect(instance.read('p1', 'a')).not.toBeNull();
    expect(instance.read('p1', 'b')).toBeNull();
    expect(instance.read('p1', 'c')).not.toBeNull();
  });

  test('keeps the total under the byte bound, evicting the least recent', async () => {
    const size = JSON.stringify(page()).length;
    const { instance, advance } = store(memoryStorage(), { maxBytes: size * 2 + 400 });
    await instance.write('p1', 'a', page());
    advance(1_000);
    await instance.write('p1', 'b', page());
    advance(1_000);
    await instance.write('p1', 'c', page());

    expect(instance.read('p1', 'a')).toBeNull();
    expect(instance.read('p1', 'c')).not.toBeNull();
  });

  test('a copy older than the maximum age is not painted', async () => {
    const { instance, advance } = store(memoryStorage(), { maxAgeMs: 14 * DAY });
    await instance.write('p1', 's1', page());
    advance(15 * DAY);

    expect(instance.read('p1', 's1')).toBeNull();
  });

  test('a full storage evicts and retries, and never throws', async () => {
    const inner = memoryStorage();
    let refuse = 1;
    const storage: KeyValueStorage = {
      getItem: inner.getItem,
      removeItem: inner.removeItem,
      setItem: (key, value) => {
        if (key.endsWith('/c') && refuse > 0) {
          refuse -= 1;
          throw new Error('QuotaExceededError');
        }
        inner.setItem(key, value);
      },
    };
    const { instance, advance } = store(storage);
    await instance.write('p1', 'a', page());
    advance(1_000);
    await instance.write('p1', 'c', page());

    expect(instance.read('p1', 'c')).not.toBeNull();
    expect(instance.read('p1', 'a')).toBeNull();
  });
});

describe('whose copies', () => {
  test('another user never reads them', async () => {
    const storage = memoryStorage();
    await store(storage).instance.write('p1', 's1', page());
    const other = createSavedCopyStore({ storage, userId: 'user-b', now: () => T0 });
    expect(other.read('p1', 's1')).toBeNull();
  });

  test('remove() forgets one session', async () => {
    const { instance } = store(memoryStorage());
    await instance.write('p1', 's1', page());
    await instance.write('p1', 's2', page());
    await instance.remove('p1', 's1');
    expect(instance.read('p1', 's1')).toBeNull();
    expect(instance.read('p1', 's2')).not.toBeNull();
  });

  test('clear() forgets every copy of this user and nothing else', async () => {
    const storage = memoryStorage();
    storage.setItem('unrelated', 'kept');
    const { instance } = store(storage);
    await instance.write('p1', 's1', page());
    await instance.write('p2', 's2', page());
    await instance.clear();

    expect(instance.read('p1', 's1')).toBeNull();
    expect(instance.read('p2', 's2')).toBeNull();
    expect([...storage.data.keys()]).toEqual(['unrelated']);
  });

  test('a corrupt entry reads null and is removed', () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    storage.setItem(instance.keyFor('p1', 's1'), '{nope');
    expect(instance.read('p1', 's1')).toBeNull();
    expect(storage.data.has(instance.keyFor('p1', 's1'))).toBe(false);
  });
});

describe('a v1 copy an SDK before the session-log major kept', () => {
  // `<namespace>:<user>:<project>/<session>` held a v1 transcript window. Nothing reads it any more:
  // it is deleted when its session is written or removed, and on clear().
  const V1_KEY = (session: string) => `kortix.saved-copy:user-a:p1/${session}`;
  const V1_INDEX = 'kortix.saved-copy:user-a:index';
  function seedV1(storage: ReturnType<typeof memoryStorage>, sessions: string[]) {
    for (const session of sessions) {
      storage.setItem(V1_KEY(session), JSON.stringify({ v: 1, user: 'user-a', at: T0, e: { available: true, source: 'mirror', messages: [{}] } }));
    }
    storage.setItem(V1_INDEX, JSON.stringify({ v: 1, entries: sessions.map((s) => ({ s: `p1/${s}`, b: 10, u: T0, c: 0 })) }));
  }

  test('is never read as a page', () => {
    const storage = memoryStorage();
    seedV1(storage, ['s1']);
    expect(store(storage).instance.read('p1', 's1')).toBeNull();
  });

  test('is deleted when its session is written, and by remove()', async () => {
    const storage = memoryStorage();
    seedV1(storage, ['s1', 's2']);
    const { instance } = store(storage);
    await instance.write('p1', 's1', page());
    await instance.remove('p1', 's2');

    expect(storage.data.has(V1_KEY('s1'))).toBe(false);
    expect(storage.data.has(V1_KEY('s2'))).toBe(false);
    expect(instance.read('p1', 's1')).toEqual(page());
  });

  test('is deleted, index included, by clear()', async () => {
    const storage = memoryStorage();
    seedV1(storage, ['s1', 's2']);
    const { instance } = store(storage);
    await instance.write('p1', 's3', page());
    await instance.clear();

    expect([...storage.data.keys()]).toEqual([]);
  });
});
