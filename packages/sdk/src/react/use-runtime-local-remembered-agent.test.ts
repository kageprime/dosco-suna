/**
 * A new composer starts on the agent the person last picked in this workspace
 * (audit finding 01): after a chat with My Kortix, "New session" must not reset
 * to the project default. The pick is per workspace, new composers only, and a
 * host that keeps its own default (a channel) leaves `rememberAgent` off.
 */
import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Agent } from '../core/runtime/runtime-types';
import { runIdentityResets } from './identity-reset-registry';
import { KortixWorkspaceProvider } from './route-project';
import { type RuntimeLocal, type UseRuntimeLocalOptions, useRuntimeLocal } from './use-runtime-local';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (name: string) => ({ name, mode: 'primary' }) as unknown as Agent;
const roster = [agent('mykortix'), agent('kortix'), agent('worker')];

let root: ReactTestRenderer | undefined;
let latest: RuntimeLocal | undefined;

function Probe(props: UseRuntimeLocalOptions) {
  latest = useRuntimeLocal(props);
  return null;
}

function mount(workspaceId: string, props: UseRuntimeLocalOptions): () => RuntimeLocal {
  act(() => root?.unmount());
  act(() => {
    root = create(createElement(KortixWorkspaceProvider, { projectId: workspaceId }, createElement(Probe, props)));
  });
  return () => latest as RuntimeLocal;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  latest = undefined;
  runIdentityResets();
});

test('no pick yet: the new composer starts on the default', () => {
  const local = mount('workspace-a', { agents: roster, defaultAgentName: 'mykortix', rememberAgent: true });
  expect(local().agent.current?.name).toBe('mykortix');
});

test('a pick in a new composer seeds the next new composer in the same workspace', () => {
  let local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  act(() => local().agent.set('worker'));
  local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  expect(local().agent.current?.name).toBe('worker');
});

test('the pick stays in its workspace', () => {
  const local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  act(() => local().agent.set('worker'));
  const other = mount('workspace-b', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  expect(other().agent.current?.name).toBe('kortix');
});

test('a remembered agent the roster no longer offers falls back to the default', () => {
  let local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  act(() => local().agent.set('worker'));
  local = mount('workspace-a', { agents: [agent('mykortix'), agent('kortix')], defaultAgentName: 'kortix', rememberAgent: true });
  expect(local().agent.current?.name).toBe('kortix');
});

test('rememberAgent off (a channel composer): the place default wins over the remembered pick', () => {
  let local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  act(() => local().agent.set('worker'));
  local = mount('workspace-a', { agents: roster, defaultAgentName: 'mykortix' });
  expect(local().agent.current?.name).toBe('mykortix');
});

test('an existing session keeps its own agent', () => {
  let local = mount('workspace-a', { agents: roster, defaultAgentName: 'kortix', rememberAgent: true });
  act(() => local().agent.set('worker'));
  local = mount('workspace-a', { agents: roster, sessionId: 'session-1', boundAgentName: 'kortix', rememberAgent: true });
  expect(local().agent.current?.name).toBe('kortix');
});
