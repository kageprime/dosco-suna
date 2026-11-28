import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import { configureKortix } from '../core/http/config';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { useSessionSync } from './use-session-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
const touched: string[] = [];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  for (const id of touched.splice(0)) useSyncStore.getState().clearSession(id);
});

const SCOPE = 'p1/2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';

const SESSION = SCOPE.split('/')[1]!;
const logMissing = () => Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 });
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

type Options = NonNullable<Parameters<typeof useSessionSync>[1]>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(sessionId: string, options: Options) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let value!: ReturnType<typeof useSessionSync>;
  function Probe(props: { sessionId: string; options: Options }) {
    value = useSessionSync(props.sessionId, props.options);
    return null;
  }
  const render = (sid: string, opts: Options) =>
    React.createElement(Probe, { sessionId: sid, options: opts });
  await act(async () => {
    root = create(render(sessionId, options));
  });
  await settle();
  return {
    value: () => value,
    update: async (sid: string, opts: Options) => {
      touched.push(sid);
      await act(async () => {
        root?.update(render(sid, opts));
      });
      await settle();
    },
  };
}

const offline: Options = { kortixSessionScope: SCOPE, networkEnabled: false };

test('without a root nothing can be read yet', async () => {
  const hook = await mount('', offline);
  expect(hook.value().mirrorState).toBe('idle');
});

test('`mirror: null` reads nothing here, and the hook says absent', async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return logMissing();
  }) as unknown as typeof fetch;
  const hook = await mount('ses_copy_null', { ...offline, mirror: null });
  expect(hook.value().mirrorState).toBe('absent');
  expect(requests).toEqual([]);
});

test('an empty runtime read that landed first does not block the log read: its page goes in the store', async () => {
  touched.push('ses_copy_empty');
  // An empty runtime read is lost box state, not an empty conversation.
  useSyncStore.getState().hydrate('ses_copy_empty', []);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(logPage());
  }) as unknown as typeof fetch;
  try {
    const hook = await mount('ses_copy_empty', offline);
    expect(requests).toEqual([`http://test.local/v1/workspaces/p1/sessions/${SESSION}/log?limit=40`]);
    expect(useSyncStore.getState().sessionLogs[SESSION]?.messages[golden.threads[0]!.thread_id]).toHaveLength(golden.threads[0]!.messages.length);
    expect(hook.value().mirrorState).toBe('loading');
  } finally {
    useSyncStore.getState().dropSessionLog(SESSION);
  }
});

test('between an empty runtime read and the log answer the hook says loading, not absent', async () => {
  // The host shows its boot loader on `absent`. An empty runtime read is not
  // the thread, so it must not flip the answer while the log read is on its way.
  let answer!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Promise<Response>((resolve) => {
      answer = resolve;
    });
  }) as unknown as typeof fetch;
  const hook = await mount('ses_copy_between', offline);
  expect(hook.value().mirrorState).toBe('loading');
  await act(async () => {
    useSyncStore.getState().hydrate('ses_copy_between', []);
  });
  await settle();
  expect(hook.value().mirrorState).toBe('loading');
  await act(async () => {
    answer(Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 }));
  });
  await settle();
  expect(hook.value().mirrorState).toBe('absent');
  expect(requests.filter((url) => url.includes('/transcript'))).toEqual([]);
});

test('a genuinely empty new session (empty runtime read, no saved copy) ends absent', async () => {
  globalThis.fetch = mock(async () => logMissing()) as unknown as typeof fetch;
  touched.push('ses_copy_new');
  useSyncStore.getState().hydrate('ses_copy_new', []);
  const hook = await mount('ses_copy_new', offline);
  expect(hook.value().mirrorState).toBe('absent');
  expect(hook.value().messages).toHaveLength(0);
});

test('a runtime read with messages makes no saved-history read', async () => {
  touched.push('ses_copy_live');
  useSyncStore.getState().hydrate('ses_copy_live', [
    {
      info: { id: 'msg_live', sessionID: 'ses_copy_live', role: 'user', time: { created: 5 } } as never,
      parts: [],
    },
  ]);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(logPage());
  }) as unknown as typeof fetch;
  const hook = await mount('ses_copy_live', offline);
  expect(hook.value().messages.map((m) => m.info.id)).toEqual(['msg_live']);
  expect(hook.value().mirrorState).toBe('painted');
  expect(requests).toEqual([]);
});

test("a new source waits for its own answer, not the last source's", async () => {
  globalThis.fetch = mock(async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const hook = await mount('ses_copy_switch', { ...offline, mirror: null });
  expect(hook.value().mirrorState).toBe('absent');
  // The host stops supplying the copy (its flag turned off): the default read
  // starts, and until it answers nothing is ruled out.
  await hook.update('ses_copy_switch', offline);
  expect(hook.value().mirrorState).toBe('loading');
});
