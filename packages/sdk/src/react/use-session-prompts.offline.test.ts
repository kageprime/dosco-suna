import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { startSessionWithPrompt, useNetworkOnline, useSessionUnsentPrompts, useSessionPrompts } from './use-session-prompts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Finding 07: a message sent while offline showed "Thinking", a timer and Stop
 * for as long as the outage lasted, while no request left the page. TanStack
 * pauses the POST while offline; the hook must not claim the send was taken
 * until it actually goes out.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  onlineManager.setOnline(true);
  configureKortix({ backendUrl: '', getToken: async () => null });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function serve(hold?: Promise<void>) {
  const posts: string[] = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    if (options.method === 'POST') {
      posts.push(String(url));
      if (hold) await hold;
      return Response.json({ prompt_id: 'p_real', state: 'queued', message_id: 'msg_1', observed_at: new Date().toISOString() });
    }
    // After the POST the server lists the row it took.
    const prompts = posts.length
      ? [{ prompt_id: 'p_real', client_message_id: 'c_1', message_id: 'msg_1', state: 'queued', reason: null, text: 'hello', full_text: 'hello', attempts: 0, last_error: null, created_at: new Date().toISOString(), available_at: new Date().toISOString() }]
      : [];
    return Response.json({ prompts, observed_at: new Date().toISOString() });
  }) as unknown as typeof fetch;
  return posts;
}

async function mount(sessionId: string) {
  configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: { prompts: ReturnType<typeof useSessionPrompts>; unsent: readonly string[]; online: boolean };
  function Probe() {
    value = {
      prompts: useSessionPrompts('p1', sessionId, { pollMs: 600_000 }),
      unsent: useSessionUnsentPrompts(sessionId),
      online: useNetworkOnline(),
    };
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await tick();
  });
  return {
    current: () => value,
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

const input = { clientMessageId: 'c_1', messageId: 'msg_1', parts: [{ type: 'text' as const, text: 'hello' }] };

test('offline: the message is listed as not sent, nothing claims it was taken, and one POST goes out on reconnect', async () => {
  const posts = serve();
  const hook = await mount('s_offline');
  await act(async () => {
    onlineManager.setOnline(false);
    await tick();
  });
  expect(hook.current().online).toBe(false);

  let sending!: Promise<unknown>;
  await act(async () => {
    sending = hook.current().prompts.enqueue(input);
    await tick();
  });
  // The row is on screen, marked unsent; no request, and no "working" claim.
  expect(hook.current().prompts.prompts.map((p) => p.client_message_id)).toEqual(['c_1']);
  expect(hook.current().unsent).toEqual(['msg_1']);
  expect(posts).toHaveLength(0);
  expect(useSessionWorkingStore.getState().inbox['s_offline']?.pending ?? 0).toBe(0);

  await act(async () => {
    onlineManager.setOnline(true);
    await sending;
    await tick();
  });
  expect(hook.current().online).toBe(true);
  expect(posts).toHaveLength(1);
  expect(hook.current().unsent).toEqual([]);
  expect(useSessionWorkingStore.getState().inbox['s_offline']?.pending).toBeGreaterThan(0);
  await hook.unmount();
});

test('online: the send is claimed at once, before the POST answers', async () => {
  let answer!: () => void;
  const posts = serve(new Promise<void>((resolve) => (answer = resolve)));
  const hook = await mount('s_online');
  let sending!: Promise<unknown>;
  await act(async () => {
    sending = hook.current().prompts.enqueue({ ...input, clientMessageId: 'c_2', messageId: 'msg_2' });
    // A few microtask hops, well inside one frame: no timer runs.
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
  });
  expect(useSessionWorkingStore.getState().inbox['s_online']?.pending).toBeGreaterThan(0);
  expect(hook.current().unsent).toEqual([]);
  await act(async () => {
    answer();
    await sending;
    await tick();
  });
  expect(posts).toHaveLength(1);
  await hook.unmount();
});

test('the first prompt of a new session, sent offline: no POST and no working claim until the network returns, then one POST', async () => {
  useSessionWorkingStore.getState().reset();
  onlineManager.setOnline(false);
  const calls: unknown[] = [];
  const sending = startSessionWithPrompt(
    'p1',
    's_first_offline',
    { parts: [{ type: 'text', text: 'hello' }] },
    {
      create: async (_projectId, _sessionId, body) => {
        calls.push(body);
        return { prompt_id: 'p_first', state: 'queued', message_id: body.messageId, deduped: false } as never;
      },
    },
  );
  await tick();
  expect(calls).toHaveLength(0);
  expect(useSessionWorkingStore.getState().receipts['s_first_offline'] ?? null).toBeNull();
  onlineManager.setOnline(true);
  expect((await sending).state).toBe('queued');
  expect(calls).toHaveLength(1);
});

test('a send held offline goes to the session it was sent in, even after the hook moves to another session', async () => {
  const posts = serve();
  configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: ReturnType<typeof useSessionPrompts>;
  function Probe({ sessionId }: { sessionId: string }) {
    value = useSessionPrompts('p1', sessionId, { pollMs: 600_000 });
    return null;
  }
  const tree = (sessionId: string) => React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { sessionId }));
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(tree('s_from'));
    await tick();
  });
  await act(async () => {
    onlineManager.setOnline(false);
    await tick();
  });
  let sending!: Promise<unknown>;
  await act(async () => {
    sending = value.enqueue({ ...input, clientMessageId: 'c_4', messageId: 'msg_4' });
    await tick();
  });
  // The person opens another session before the network returns.
  await act(async () => {
    root.update(tree('s_to'));
    await tick();
  });
  await act(async () => {
    onlineManager.setOnline(true);
    await sending;
    await tick();
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('/sessions/s_from/prompts');
  await act(async () => root.unmount());
  client.clear();
});
