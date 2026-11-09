// Characterization tests (KRTX-4504): they pin the URL every touched REST
// builder outputs BEFORE the request-construction dedupe. They must keep
// passing unchanged after it. A red one means the refactor changed behavior.
import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { listArtifacts, getArtifact, readArtifactFile } from './artifacts';
import { getAppDeploymentLogs, listAppEvents } from './apps';
import { listAccountSecretResources, refreshAccountSecretUsage } from './account-secret-resources';
import { listPermissions } from './assignments';
import { listWorkspaceGoalEvents } from './goals';
import { listWorkspaceMemoryPages } from './memory';
import { getSessionReachableAgents, listPeerMessages } from './multi-agent';

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

let calls: { url: string }[] = [];
let nextBody: Record<string, unknown> = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

const last = () => calls[calls.length - 1]!;

test('listArtifacts pins the full filter serialization byte for byte (agents repeated, reserved characters)', async () => {
  await listArtifacts('p1', {
    scope: 'mine',
    type: 'doc',
    q: 'a b&c=d+e',
    limit: 5,
    space: 'ops',
    agents: ['builder', 'writer'],
    unbound: true,
  });
  expect(last().url).toBe(
    'http://test.local/v1/workspaces/p1/artifacts?scope=mine&type=doc&q=a+b%26c%3Dd%2Be&limit=5&space=ops&agent=builder&agent=writer&unbound=1',
  );
});

test('listArtifacts drops empty, undefined and unset filters; limit 0 is still sent', async () => {
  await listArtifacts('p1', { q: '', type: undefined });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts');
  await listArtifacts('p1', { limit: 0 });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts?limit=0');
});

test('listArtifacts with one agent and no unbound sends one repeated agent key', async () => {
  await listArtifacts('p1', { agents: ['builder'] });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts?agent=builder');
});

test('getArtifact sends no query when the version option is empty or undefined', async () => {
  await getArtifact('p1', 'a1');
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts/a1');
  await getArtifact('p1', 'a1', { version: '' });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts/a1');
  await getArtifact('p1', 'a1', { version: 'v 1&x' });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts/a1?version=v+1%26x');
});

test('readArtifactFile builds its URL on the configured backend base, no version or path sent when unset', async () => {
  const blob = await readArtifactFile('p1', 'a1');
  expect(blob).toBeInstanceOf(Blob);
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/artifacts/a1/content');
  await readArtifactFile('p1', 'a1', { path: 'folder f/index.html', version: 'v 1&x' });
  expect(last().url).toBe(
    'http://test.local/v1/workspaces/p1/artifacts/a1/content?path=folder+f%2Findex.html&version=v+1%26x',
  );
});

test('getAppDeploymentLogs drops unset fields and keeps after=0/limit=0', async () => {
  await getAppDeploymentLogs('p1', 'a1', 'd1');
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/apps/a1/deployments/d1/logs');
  await getAppDeploymentLogs('p1', 'a1', 'd1', { after: 0, limit: 0 });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/apps/a1/deployments/d1/logs?after=0&limit=0');
});

test('listAppEvents drops unset fields, pins a limit of 0 and reserved characters', async () => {
  await listAppEvents('p1', 'a1', { limit: 0 });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/apps/a1/events?limit=0');
  await listAppEvents('p1', 'a1', { cursor: 'a&b=c', trigger: 't 1' });
  expect(last().url).toBe(
    'http://test.local/v1/workspaces/p1/apps/a1/events?cursor=a%26b%3Dc&trigger=t+1',
  );
});

test('listWorkspaceGoalEvents encodes the cursor; unset builds no query', async () => {
  await listWorkspaceGoalEvents('p1', 'g1', { cursor: 'n/1&x' });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/goals/g1/events?cursor=n%2F1%26x');
  await listWorkspaceGoalEvents('p1', 'g1');
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/goals/g1/events');
});

test('getSessionReachableAgents and listPeerMessages encode the query values', async () => {
  await getSessionReachableAgents('p1', 's1', { scope: 'project' });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/sessions/s1/reachable?scope=project');
  await getSessionReachableAgents('p1', 's1');
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/sessions/s1/reachable');
  nextBody = { messages: [] };
  expect(await listPeerMessages('p1', 's1', { direction: 'out' })).toEqual({ messages: [] });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/sessions/s1/peer-messages?direction=out');
  expect(await listPeerMessages('p1', 's1')).toEqual({ messages: [] });
});

test('listPermissions narrows the scope; unset builds no query', async () => {
  await listPermissions('acc1', { scopeType: 'project' });
  expect(last().url).toBe('http://test.local/v1/accounts/acc1/iam/permissions?scope_type=project');
  await listPermissions('acc1');
  expect(last().url).toBe('http://test.local/v1/accounts/acc1/iam/permissions');
});

test('account secret resource reads carry the project id encoded; unset builds no query', async () => {
  await listAccountSecretResources('acc1', 'p/1&x');
  expect(last().url).toBe('http://test.local/v1/accounts/acc1/secret-resources?project_id=p%2F1%26x');
  await refreshAccountSecretUsage('acc1', 'sec1', 'p/1&x');
  expect(last().url).toBe('http://test.local/v1/accounts/acc1/secret-resources/sec1/usage?project_id=p%2F1%26x');
  await listAccountSecretResources('acc1');
  expect(last().url).toBe('http://test.local/v1/accounts/acc1/secret-resources');
});

test('listWorkspaceMemoryPages pins the type filter; unset builds no query', async () => {
  await listWorkspaceMemoryPages('p1', 'company', { type: 'note' });
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/memory/layers/company/pages?type=note');
  await listWorkspaceMemoryPages('p1', 'company');
  expect(last().url).toBe('http://test.local/v1/workspaces/p1/memory/layers/company/pages');
});
