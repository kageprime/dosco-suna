import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';

import { createKortix } from '@kortix/sdk';
import { useProjectSessions } from '@kortix/sdk/react';
import { testRender } from '@opentui/react/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { pollDueQueries } from '../../lib/query-polling.ts';
import { LIVE_POLL_MS, useRefreshSessions, useSidebarSessions } from './use-sidebar-sessions.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = 'P1';
const BUCKETS = ['all', 'me', 'others', 'automated'] as const;
type Bucket = (typeof BUCKETS)[number];

/** Requests per list, keyed by the `started_by` they sent ('all' = none). */
let requests: Record<Bucket, number>;
let statusOf: Partial<Record<Bucket, string>>;
let refreshApp: () => Promise<unknown>;
let refreshSidebar: () => Promise<unknown>;
let destroy: () => void = () => {};

// A real local server, so the SDK's own requests are what the test counts.
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const startedBy = new URL(request.url).searchParams.get('started_by') ?? 'all';
    const bucket = BUCKETS.find((name) => name === startedBy) ?? 'all';
    requests[bucket] += 1;
    return Response.json([{ session_id: `S-${bucket}`, status: statusOf[bucket] ?? 'completed' }]);
  },
});
createKortix({ backendUrl: `http://127.0.0.1:${server.port}/v1`, getToken: async () => 'token' });

beforeEach(() => {
  requests = { all: 0, me: 0, others: 0, automated: 0 };
  statusOf = {};
});

afterAll(() => server.stop(true));

afterEach(() => {
  destroy();
});

/** The app's unfiltered list and the sidebar's buckets, mounted together as in the TUI. */
function Probe() {
  useProjectSessions(PROJECT, { enabled: true });
  refreshApp = useRefreshSessions(PROJECT);
  refreshSidebar = useSidebarSessions(PROJECT).refresh;
  return <text>probe</text>;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { renderer } = await testRender(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
    { width: 20, height: 2 },
  );
  destroy = () => renderer.destroy();
  await settle(client);
  return client;
}

/** Wait until every request the hooks started has been answered. */
async function settle(client: QueryClient) {
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } while (client.isFetching() > 0);
}

describe('useSidebarSessions (KRTX-4898)', () => {
  test('a refresh from the app or the sidebar refetches all four session lists', async () => {
    await mount();
    expect(requests).toEqual({ all: 1, me: 1, others: 1, automated: 1 });

    await act(async () => {
      await refreshApp();
    });
    expect(requests).toEqual({ all: 2, me: 2, others: 2, automated: 2 });

    await act(async () => {
      await refreshSidebar();
    });
    expect(requests).toEqual({ all: 3, me: 3, others: 3, automated: 3 });
  });

  test('every bucket with a live row polls; a settled bucket does not', async () => {
    statusOf = { others: 'running', automated: 'running' };
    const client = await mount();
    expect(requests).toEqual({ all: 1, me: 1, others: 1, automated: 1 });

    // The TUI's own poll driver (TanStack schedules no `refetchInterval` in Bun).
    await act(async () => {
      pollDueQueries(client, Date.now() + LIVE_POLL_MS);
    });
    await settle(client);
    expect(requests).toEqual({ all: 1, me: 1, others: 2, automated: 2 });
  });
});
