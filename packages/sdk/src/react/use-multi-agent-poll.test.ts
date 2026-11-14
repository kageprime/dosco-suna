import { afterEach, expect, jest, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// TanStack Query schedules no `refetchInterval` timer where `window` is
// undefined (its `isServer`). Define it before the library loads, so the
// timers run here as they do in a browser.
(globalThis as any).window ??= globalThis;
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { configureKortix } = await import('../core/http/config');
const { usePeerMessages, useTeammates } = await import('./use-multi-agent');

// One idle session tab sent 12 `peer-messages` reads a minute per mounted
// reader, and every extra reader of the same list added its own timer: an
// audit counted 78 workflow reads a minute from one tab. These tests mount
// several readers of one list and count the requests over fake time.

let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  jest.useRealTimers();
});

function countRequests(match: string) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return Response.json(String(url).includes(match) ? { messages: [] } : []);
  }) as unknown as typeof fetch;
  return () => calls.filter((url) => url.includes(match)).length;
}

async function mount(children: React.ReactNode) {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(React.createElement(QueryClientProvider, { client }, children));
  });
  await settle();
}

async function settle() {
  await act(async () => {
    for (let hop = 0; hop < 30; hop++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await settle();
  }
}

function PeerReader() {
  usePeerMessages('p1', 's1', 'in', { live: false });
  return null;
}

function TeammatesReader({ live }: { live: boolean }) {
  useTeammates('p1', 's1', { live });
  return null;
}

test('six readers of one idle list send one request per idle interval, not one each', async () => {
  jest.useFakeTimers();
  const requests = countRequests('/peer-messages');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const readers = (count: number) =>
    React.createElement(
      QueryClientProvider,
      { client },
      Array.from({ length: count }, (_, i) => React.createElement(PeerReader, { key: i })),
    );
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  await act(async () => {
    renderer = create(readers(1));
  });
  await settle();
  // A page mounts its readers at different moments, so their timers never line up.
  for (let count = 2; count <= 6; count++) {
    await advance(1_000);
    await act(async () => renderer?.update(readers(count)));
    await settle();
  }
  const afterMount = requests();

  await advance(60_000);

  // Idle: one read every 30 s, shared by all six readers.
  expect(requests() - afterMount).toBe(2);
});

test('a session that works polls its agents every 5 s; an idle one every 30 s', async () => {
  jest.useFakeTimers();
  const requests = countRequests('team_lead=');
  await mount(React.createElement(TeammatesReader, { live: true }));
  const afterMount = requests();
  await advance(30_000);
  expect(requests() - afterMount).toBe(6);

  await act(async () => {
    renderer?.update(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        React.createElement(TeammatesReader, { live: false }),
      ),
    );
  });
  await settle();
  const afterIdle = requests();
  await advance(60_000);
  expect(requests() - afterIdle).toBe(2);
});
