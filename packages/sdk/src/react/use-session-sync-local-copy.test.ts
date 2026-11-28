import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import type { KeyValueStorage } from '../core/cache/persisted-query-cache';
import { configureKortix } from '../core/http/config';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { createSavedCopyStore, setSavedCopyStore } from '../core/session-sync/saved-copy-store';

// A browser has a `window`; the hook picks its effect kinds at load. Loaded
// after this line, so the commit-phase test below sees what a browser runs.
const hadWindow = 'window' in globalThis;
if (!hadWindow) (globalThis as { window?: unknown }).window = globalThis;
const { useSessionSync } = await import('./use-session-sync');

/**
 * The hook's saved-history read: the session log's newest page (`GET …/log`) goes in the
 * session store. `mirror: null` (the host reads it) and `sessionLog` (the log owns the session)
 * read nothing. No v1 transcript is read, from the network or the device (P8.3, P8.4).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
const touched: string[] = [];

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  setSavedCopyStore(null);
  for (const id of touched.splice(0)) useSyncStore.getState().clearSession(id);
});

const PROJECT = 'p1';
const SESSION = '2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';
const SCOPE = `${PROJECT}/${SESSION}`;

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

/** What a v1 route answered. Served for every route but `/log`, so a v1 read would be seen. */
const v1Body = () => Response.json({ available: true, source: 'mirror', messages: [] });

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

type Options = NonNullable<Parameters<typeof useSessionSync>[1]>;

/**
 * The device-copy tests model a session with no log page: `mount` answers `GET …/log` 404
 * before the test's own fetch sees it. The log tests at the end serve the log through their own
 * fetch (`logServed`).
 */
let logServed = false;
afterEach(() => {
  logServed = false;
});

async function mount(sessionId: string, options: Options) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    !logServed && String(input instanceof Request ? input.url : input).includes('/log?')
      ? Response.json({ error: 'Not found' }, { status: 404 })
      : inner(input, init)) as typeof fetch;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync(sessionId, options);
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  return { value: () => value };
}

const offline: Options = { kortixSessionScope: SCOPE, networkEnabled: false };

test('a host that hands in `mirror: null` reads it itself: no request here, and the hook answers absent', async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  logServed = true;
  const hook = await mount('ses_host_reads', { ...offline, mirror: null });
  await settle();
  expect(requests).toEqual([]);
  expect(hook.value().messages).toHaveLength(0);
  expect(hook.value().mirrorState).toBe('absent');
});

test('a session the session log owns (v2) reads no saved copy: no request, no device read, nothing after a turn', async () => {
  const storage = memoryStorage();
  setSavedCopyStore(createSavedCopyStore({ storage, userId: 'user-a' }));
  const read = storage.getItem;
  let reads = 0;
  storage.getItem = (key) => {
    reads += 1;
    return read(key);
  };
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return v1Body();
  }) as unknown as typeof fetch;
  touched.push('ses_log_owned');
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let working = true;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync('ses_log_owned', { ...offline, sessionLog: true, working });
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  await settle();
  working = false;
  await act(async () => {
    root?.update(React.createElement(Probe));
  });
  await settle();

  expect(requests).toEqual([]);
  expect(reads).toBe(0);
  expect(value.messages).toHaveLength(0);
  expect(value.hasOlder).toBe(false);
});

// The session log (P8): a host that hands in no saved copy, and a sub-agent's view, read
// `GET …/log`. A page goes in the session store, so the host renders the log's thread.
const golden = JSON.parse(
  (await import('node:fs')).readFileSync(
    (await import('node:path')).join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'),
    'utf8',
  ),
) as { threads: Array<{ thread_id: string; messages: unknown[] } & Record<string, unknown>> } & Record<string, unknown>;
const logPage = () => {
  const { threads, ...session } = structuredClone(golden);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
};

for (const savedChild of [false, true]) {
  test(`${savedChild ? 'a sub-agent' : 'a host that hands in no saved copy'}: the log page goes in the store, and no /transcript is read`, async () => {
    logServed = true;
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      requests.push(String(url));
      if (String(url).includes('/log?')) return Response.json(logPage());
      return v1Body();
    }) as unknown as typeof fetch;
    try {
      const hook = await mount('ses_log_first', { ...offline, savedChild });
      await settle();
      expect(requests).toEqual([`http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/log?limit=40`]);
      expect(useSyncStore.getState().sessionLogs[SESSION]?.messages[golden.threads[0]!.thread_id]).toHaveLength(golden.threads[0]!.messages.length);
      expect(hook.value().messages).toHaveLength(0);
      expect(hook.value().mirrorState).not.toBe('absent');
    } finally {
      useSyncStore.getState().dropSessionLog(SESSION);
    }
  });
}

test("a session whose log the store already holds (the route's useSession read it) reads no saved copy, whatever `sessionLog` says", async () => {
  logServed = true;
  useSyncStore.getState().applySessionLogPage(SESSION, logPage() as never);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return v1Body();
  }) as unknown as typeof fetch;
  try {
    await mount('ses_log_held', { ...offline, savedChild: true });
    await settle();
    expect(requests).toEqual([]);
  } finally {
    useSyncStore.getState().dropSessionLog(SESSION);
  }
});

test('a new session on an API that serves the log (404 session_log_missing): no /transcript, and no saved copy', async () => {
  logServed = true;
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    if (String(url).includes('/log?')) return Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 });
    return v1Body();
  }) as unknown as typeof fetch;
  const hook = await mount('ses_log_missing', offline);
  await settle();
  expect(requests).toEqual([`http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/log?limit=40`]);
  expect(hook.value().messages).toHaveLength(0);
  expect(hook.value().mirrorState).toBe('absent');
});

// P8.3: a current client sends no `GET …/transcript`. The session log is the only saved copy;
// a session without a page shows what the runtime has (or the boot screen) instead.
describe('no GET …/transcript on any path (P8.3)', () => {
  const failures = {
    'a 404 without a code': () => Response.json({ error: 'No session log for this session' }, { status: 404 }),
    'a 500': () => Response.json({ error: 'Internal Server Error' }, { status: 500 }),
    'an invalid page': () => Response.json({ ...logPage(), messages: [{ seq: 'x' }] }),
  };
  function recordAll(log: () => Response): string[] {
    logServed = true;
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      requests.push(String(url));
      if (String(url).includes('/log?')) return log();
      return v1Body();
    }) as unknown as typeof fetch;
    return requests;
  }
  const v1Reads = (requests: string[]) => requests.filter((url) => url.includes('/transcript'));

  for (const [name, answer] of Object.entries(failures)) {
    for (const savedChild of [false, true]) {
      test(`${savedChild ? 'a sub-agent' : 'a host that hands in no saved copy'}, GET …/log answers ${name}: no /transcript, nothing saved`, async () => {
        const requests = recordAll(answer);
        const hook = await mount('ses_no_v1', { ...offline, savedChild });
        await settle();
        expect(requests).toEqual([`http://test.local/v1/workspaces/${PROJECT}/sessions/${SESSION}/log?limit=40`]);
        expect(v1Reads(requests)).toEqual([]);
        expect(hook.value().messages).toHaveLength(0);
        expect(hook.value().mirrorState).toBe('absent');
      });
    }
  }

  // `useSession({ chatEngine: false })` (apps/mobile) mounts `useSessionSync('')` with the
  // session's scope and its `working` answer; the thread page mounts its own without `working`.
  for (const sessionId of ['', 'ses_turn_end_no_v1']) {
    test(`a turn end reads no saved copy (useSessionSync(${JSON.stringify(sessionId)}), no log in the store): no /transcript`, async () => {
      const requests = recordAll(() => Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 }));
      const later: Array<() => void> = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void, ms?: number) => {
        if ((ms ?? 0) >= 1_000) {
          later.push(callback);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(callback, ms);
      }) as typeof setTimeout;
      try {
        let working = true;
        if (sessionId) touched.push(sessionId);
        configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
        function Probe() {
          useSessionSync(sessionId, { ...offline, working });
          return null;
        }
        await act(async () => {
          root = create(React.createElement(Probe));
        });
        await settle();
        working = false;
        await act(async () => {
          root?.update(React.createElement(Probe));
        });
        // Every timer of a second or more runs now: the clock is not waited on.
        await act(async () => {
          for (const run of later.splice(0)) run();
          await new Promise((resolve) => realSetTimeout(resolve, 20));
        });
        expect(v1Reads(requests)).toEqual([]);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });
  }
});
