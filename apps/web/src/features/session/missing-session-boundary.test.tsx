import { clearSessionFresh, configureKortix, markSessionFresh, SessionStartError, sessionStartKey } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test } from 'bun:test';
import { type ComponentType, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MissingSessionBoundary } from './missing-session-boundary';

let renderer: ReactTestRenderer | undefined;
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clearSessionFresh('fresh');
});

const ROW_URL = 'http://api.test/v1/workspaces/project/sessions/session';

/** Every request the boundary sends, answered by `answer`. */
function serve(answer: (url: string) => Promise<Response>): string[] {
  const urls: string[] = [];
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'synthetic-token',
    onError: () => {},
    fetch: async (url) => {
      urls.push(String(url));
      return answer(String(url));
    },
  });
  return urls;
}

/** Live session readers that record whether they ever mounted. */
function readers() {
  const state = { mounted: false, everMounted: false };
  function LiveReaders() {
    useEffect(() => {
      state.mounted = true;
      state.everMounted = true;
      return () => {
        state.mounted = false;
      };
    }, []);
    return <span>Live session</span>;
  }
  return { state, LiveReaders };
}

async function mount(sessionId: string, LiveReaders: ComponentType) {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MissingSessionBoundary
          projectId="project"
          sessionId={sessionId}
          pending={<span>Loading session</span>}
          fallback={<span>Session not found</span>}
        >
          <LiveReaders />
        </MissingSessionBoundary>
      </QueryClientProvider>,
    );
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const text = () => JSON.stringify(renderer?.toJSON());

test('a session whose row answers 404 renders not-found and never mounts its readers', async () => {
  const urls = serve(async () => Response.json({ message: 'Not found' }, { status: 404 }));
  const { state, LiveReaders } = readers();
  await mount('session', LiveReaders);
  await settle();
  expect(state.everMounted).toBe(false);
  expect(text()).toContain('Session not found');
  // The row read is the only request: no `/start`, no stream, no poll.
  expect(urls).toEqual([ROW_URL]);
});

test('an existing session holds its readers until its row answers, then mounts them', async () => {
  let answerRow: (() => void) | undefined;
  serve(
    () =>
      new Promise((resolve) => {
        answerRow = () => resolve(Response.json({ session_id: 'session', project_id: 'project' }));
      }),
  );
  const { state, LiveReaders } = readers();
  await mount('session', LiveReaders);
  await settle();
  expect(state.everMounted).toBe(false);
  expect(text()).toContain('Loading session');
  await act(async () => answerRow?.());
  await settle();
  expect(state.mounted).toBe(true);
});

test('a failing row read mounts the session at once instead of waiting out its retries', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 60_000 } } });
  const urls = serve(async () => Response.json({ message: 'Server error' }, { status: 500 }));
  const { state, LiveReaders } = readers();
  await mount('session', LiveReaders);
  await settle();
  expect(urls).toEqual([ROW_URL]);
  expect(state.mounted).toBe(true);
});

test('a definitive missing-session answer unmounts live readers, but a transient failure does not', async () => {
  serve(async () => Response.json({ message: 'Unexpected request' }, { status: 500 }));
  client.setQueryData(qk.project.session('project', 'session'), { session_id: 'session' });
  const { state, LiveReaders } = readers();
  await mount('session', LiveReaders);
  expect(state.mounted).toBe(true);
  const key = sessionStartKey('project', 'session');
  async function fail(status: number) {
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: key,
          queryFn: async () => {
            throw new SessionStartError('request failed', { status, terminal: status === 404 });
          },
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  await fail(503);
  expect(state.mounted).toBe(true);
  await fail(404);
  expect(state.mounted).toBe(false);
  expect(text()).toContain('Session not found');
});

test('a retrying fresh-session miss does not remove its start owner', async () => {
  const urls = serve(async () => Response.json({ message: 'Not found' }, { status: 404 }));
  markSessionFresh('fresh');
  let finishRetry: (() => void) | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MissingSessionBoundary
          projectId="project"
          sessionId="fresh"
          pending={<span>Loading session</span>}
          fallback={<span>Missing</span>}
        >
          <span>Starting</span>
        </MissingSessionBoundary>
      </QueryClientProvider>,
    );
  });
  expect(text()).toContain('Starting');
  let calls = 0;
  const request = client.fetchQuery({
    queryKey: sessionStartKey('project', 'fresh'),
    queryFn: async () => {
      calls++;
      if (calls === 1)
        throw new SessionStartError('create pending', { status: 404, terminal: true });
      await new Promise<void>((resolve) => {
        finishRetry = resolve;
      });
      return { sandbox_id: 'sandbox' };
    },
    retry: 1,
    retryDelay: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls).toBe(2);
  expect(text()).toContain('Starting');
  // The page clears the fresh mark once the session opens; that must not
  // turn the create race into a not-found screen.
  clearSessionFresh('fresh');
  await act(async () => {
    finishRetry?.();
    await request;
  });
  expect(text()).toContain('Starting');
  // A fresh session's row is not read by the boundary: its create may not have landed.
  expect(urls).toEqual([]);
});
