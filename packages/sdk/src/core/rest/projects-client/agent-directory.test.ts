import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import { listWorkspaceAgentDirectory, setWorkspaceAgentPaused, type WorkspaceAgentEntry } from './agent-directory';

let calls: { url: string; method: string }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
});

const marketing: WorkspaceAgentEntry = {
  name: 'marketing',
  display_name: 'marketing',
  model: null,
  status: 'active',
  is_default: true,
  builtin: false,
  chat_space_id: null,
};

test('listWorkspaceAgentDirectory GETs the agent-directory route and returns the array', async () => {
  nextResponse = { status: 200, body: { agents: [marketing] } };
  const agents = await listWorkspaceAgentDirectory('P1');
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/agent-directory', method: 'GET' }]);
  expect(agents).toEqual([marketing]);
});

test('listWorkspaceAgentDirectory rejects with feature_disabled while channels is off and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 403, body: { error: 'Feature disabled', code: 'feature_disabled', feature: 'channels' } };
  const error = await listWorkspaceAgentDirectory('P1').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 403, code: 'feature_disabled' });
  expect(errors).toEqual([]);
});

test('setWorkspaceAgentPaused POSTs { paused } to the agent pause route and returns the agent', async () => {
  nextResponse = { status: 200, body: { agent: { ...marketing, status: 'paused' }, stopped_sessions: 2 } };
  const result = await setWorkspaceAgentPaused('P1', 'marketing', true);
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/agent-directory/marketing/pause', method: 'POST' }]);
  expect(result.agent.status).toBe('paused');
  expect(result.stopped_sessions).toBe(2);
});
