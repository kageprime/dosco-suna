import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { invalidatePermissionProbes, useCan, useCans } from './use-can';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A workspace home sent 6 to 12 `effective:batch` POSTs on its first load:
// `useCans` posted its own batch beside the coalesced `useCan` probes, and a
// gate that mounted later asked again for answers the page already had.

const ME = 'user-1';
const TARGET = { projectId: 'proj-1', accountId: 'acc-1' };
const WIDE = ['project.write', 'project.secret.write', 'project.members.manage'] as const;
const NARROW = ['project.write', 'project.members.manage'] as const;

let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

function recordBatches() {
  const batches: string[][] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const probes = (JSON.parse(String(init.body ?? '{}')).probes ?? []) as Array<{ action: string }>;
    if (String(url).includes('effective:batch')) batches.push(probes.map((probe) => probe.action));
    return Response.json({
      results: probes.map((probe) => ({
        action: probe.action,
        resource_type: 'project',
        resource_id: 'proj-1',
        allowed: probe.action !== 'project.members.manage',
        reason: 'role',
      })),
    });
  }) as unknown as typeof fetch;
  return batches;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let hop = 0; hop < 30; hop++) await Promise.resolve();
  });
}

const verdicts: Record<string, Record<string, boolean>> = {};

function Single({ id, action }: { id: string; action: string }) {
  verdicts[id] = { [action]: useCan(TARGET, action, { userId: ME }).allowed };
  return null;
}

function Many({ id, actions }: { id: string; actions: readonly string[] }) {
  const caps = useCans(TARGET, actions, { userId: ME });
  verdicts[id] = Object.fromEntries(actions.map((action) => [action, caps[action].allowed]));
  return null;
}

test('gates that mount together send one batch, and a later gate reuses the answers', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const batches = recordBatches();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (later: boolean) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Single, { id: 'single', action: 'project.secret.write' }),
      React.createElement(Many, { id: 'wide', actions: WIDE }),
      later ? React.createElement(Many, { id: 'narrow', actions: NARROW }) : null,
    );

  await act(async () => {
    renderer = create(page(false));
  });
  await settle();
  expect(batches).toHaveLength(1);
  expect([...batches[0]].sort()).toEqual([...WIDE].sort());

  await act(async () => renderer?.update(page(true)));
  await settle();
  expect(batches).toHaveLength(1);
  expect(verdicts.narrow).toEqual({ 'project.write': true, 'project.members.manage': false });
  expect(verdicts.single).toEqual({ 'project.secret.write': true });

  // A permission change invalidates the probes: the next read asks the server again.
  await act(async () => invalidatePermissionProbes(client, { accountId: 'acc-1' }));
  await settle();
  expect(batches.length).toBeGreaterThan(1);
});

test('a batch never keeps a verdict past the single-probe freshness window', async () => {
  const { setSystemTime } = await import('bun:test');
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const batches = recordBatches();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const start = Date.parse('2026-11-13T00:00:00Z');
  setSystemTime(new Date(start));
  try {
    // A verdict cached 299 s ago: still fresh for one more second.
    for (const action of NARROW) {
      client.setQueryData(
        ['iam-permission', 'acc-1', ME, action, 'project', 'proj-1'],
        { action, resource_type: 'project', resource_id: 'proj-1', allowed: true, reason: 'role' },
        { updatedAt: start - 299_000 },
      );
    }
    const page = (key: string) =>
      React.createElement(QueryClientProvider, { client }, React.createElement(Many, { key, id: key, actions: NARROW }));
    await act(async () => {
      renderer = create(page('first'));
    });
    await settle();
    expect(batches).toHaveLength(0);

    // Two seconds later the verdict is 301 s old: a new gate asks the server.
    setSystemTime(new Date(start + 2_000));
    await act(async () => renderer?.update(page('second')));
    await settle();
    expect(batches).toHaveLength(1);
  } finally {
    setSystemTime();
  }
});
