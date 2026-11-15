import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix, toolCallBlock } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import type { ToolPart } from '../../../internal/session-types';
import { IntlTestProvider } from '../../../test-utils/intl';
import { SessionIdsProvider } from '../../../providers/session-ids';

// Synthetic values only: every id, name and text below is invented.
//
// Audit finding 06: a colleague row reads the child's own row
// (`qk.project.session(child)`), the agents line polls the parent's children
// (`qk.project.sessionChildren`). A row read while the child worked said
// "Working" for minutes after the strip said done. The children poll is now
// the live source for both.

// The row's transcript read is not under test; it would fetch the child's log.
const real = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...real, useSessionLogThread: () => null }));
const { TaskTool } = await import('./task-tool');
const { useSessionChildren } = real;

const P = 'proj-synthetic';
const PARENT = 'sess-parent-synthetic';
const CHILD = 'sess-child-synthetic';
const busy = { state: 'working', since: '2026-11-15T10:00:00.000Z', turn_token: 't1', pending_delivery: false };
const idle = { state: 'idle', since: null, turn_token: null, pending_delivery: false };
const childRow = (fields: Record<string, unknown>) => ({
  session_id: CHILD,
  project_id: P,
  status: 'running',
  runtime_status: 'active',
  agent_name: 'general',
  name: 'Check the numbers',
  metadata: { spawned_by_session: PARENT },
  updated_at: '2026-11-15T10:00:00.000Z',
  ...fields,
});

let children: unknown[] = [];
const originalFetch = globalThis.fetch;
const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
let root: ReactTestRenderer | undefined;
let refetchChildren: () => Promise<unknown> = async () => undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  globalThis.fetch = mock(async (url: unknown) => {
    const href = String(url);
    if (href.includes(`parent=${PARENT}`)) return Response.json(children);
    return Response.json({ error: 'not under test' }, { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  if (originalAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalAct);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

const call = toolCallBlock({
  type: 'tool',
  tool: 'task',
  callID: 'call-synthetic',
  state: {
    status: 'running',
    input: { description: 'Check the numbers', prompt: 'Check the numbers', subagent_type: 'general' },
    metadata: { sessionId: CHILD },
  },
} as unknown as ToolPart);

/** The agents line's poll, as `agent-strip.tsx` mounts it. */
function ChildrenPoll() {
  const list = useSessionChildren(P, PARENT, { limit: 50 });
  refetchChildren = list.refetch;
  return null;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const text = () => JSON.stringify(root!.toJSON());

describe('TaskTool colleague row follows the children poll', () => {
  test('the row flips Working → Done when the children list says done, with no other invalidation', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The row was read mid-run (a reload, a second tab): its own entry says working and stays fresh 30 s.
    client.setQueryData(qk.project.session(P, CHILD), childRow({ working: busy, board_state: 'working' }));
    children = [childRow({ working: busy, board_state: 'working' })];
    await act(async () => {
      root = create(
        <QueryClientProvider client={client}>
          <IntlTestProvider>
            <SessionIdsProvider projectId={P} sessionId={PARENT}>
              <ChildrenPoll />
              <TaskTool call={call} />
            </SessionIdsProvider>
          </IntlTestProvider>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i++) await settle();
    expect(text()).toContain('Working');
    expect(text()).not.toContain('Done');

    // The child finished. The next poll of the children list is the only signal.
    children = [childRow({ working: idle, board_state: 'completed', result_excerpt: 'All checked.', updated_at: '2026-11-15T10:01:00.000Z' })];
    await act(async () => {
      await refetchChildren();
    });
    for (let i = 0; i < 5; i++) await settle();
    expect(text()).toContain('Done');
    expect(text()).not.toContain('Working');
  });
});
