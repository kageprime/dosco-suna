import { describe, expect, test } from 'bun:test';

import type { SessionConnectRequest } from '../../rest/projects-client/connectors';
import type { ToolCallBlock } from '../../session-log/types';
import { connectorSignInCalls, connectorSignInRequests, toolCallConnectorSignIns } from './connector-sign-in';

const bash = (command: unknown) => connectorSignInCalls('bash', { command });

describe('connectorSignInCalls', () => {
  test('a shell `kortix connectors connect <slug>` is a private sign-in by default', () => {
    expect(bash('kortix connectors connect gmail')).toEqual([{ slug: 'gmail', owner: 'member' }]);
  });

  test('`--owner workspace` and `--owner project` are the shared sign-in, `--owner me` the private one', () => {
    expect(bash('kortix connectors connect notion --owner workspace')).toEqual([{ slug: 'notion', owner: 'project' }]);
    expect(bash('kortix connectors connect notion --owner=project')).toEqual([{ slug: 'notion', owner: 'project' }]);
    expect(bash('kortix connectors connect notion --owner me --json')).toEqual([{ slug: 'notion', owner: 'member' }]);
    expect(bash('kortix connectors connect --owner workspace linear')).toEqual([{ slug: 'linear', owner: 'project' }]);
  });

  test('the command may sit in a chain, after a path, or span several sign-ins', () => {
    expect(bash('cd /workspace && /usr/local/bin/kortix connectors connect supabase_read_mcp 2>&1')).toEqual([
      { slug: 'supabase_read_mcp', owner: 'member' },
    ]);
    expect(bash('kortix connectors connect gmail; kortix connectors connect slack --owner workspace')).toEqual([
      { slug: 'gmail', owner: 'member' },
      { slug: 'slack', owner: 'project' },
    ]);
  });

  test('another connectors command, a mention in text, or a missing slug is no sign-in', () => {
    expect(bash('kortix connectors ls')).toEqual([]);
    expect(bash('kortix connectors connect')).toEqual([]);
    expect(bash('kortix connectors connect --owner me')).toEqual([]);
    expect(bash('echo "run kortix connectors connect gmail"')).toEqual([]);
    expect(bash('mykortix connectors connect gmail')).toEqual([]);
    expect(bash(undefined)).toEqual([]);
  });

  test('the `kortix_connectors` tool: `connect` with a slug, shared when `shared` or `for_trigger` says so', () => {
    expect(connectorSignInCalls('kortix_connectors', { action: 'connect', slug: 'gmail' })).toEqual([
      { slug: 'gmail', owner: 'member' },
    ]);
    expect(connectorSignInCalls('kortix_connectors', { action: 'connect', slug: 'gmail', shared: true })).toEqual([
      { slug: 'gmail', owner: 'project' },
    ]);
    expect(connectorSignInCalls('kortix-connectors', { action: 'connect', slug: 'gmail', for_trigger: true })).toEqual([
      { slug: 'gmail', owner: 'project' },
    ]);
    expect(
      connectorSignInCalls('kortix_connectors', { action: 'connect', slug: 'gmail', for_trigger: true, shared: false }),
    ).toEqual([{ slug: 'gmail', owner: 'member' }]);
  });

  test('the `kortix_connectors` tool without `connect`, or without a slug, is no sign-in', () => {
    expect(connectorSignInCalls('kortix_connectors', { action: 'list' })).toEqual([]);
    expect(connectorSignInCalls('kortix_connectors', { action: 'connect' })).toEqual([]);
    expect(connectorSignInCalls('kortix_connectors', { action: 'connect', slug: '  ' })).toEqual([]);
  });

  test('any other tool is no sign-in, whatever its input says', () => {
    expect(connectorSignInCalls('read', { command: 'kortix connectors connect gmail' })).toEqual([]);
    expect(connectorSignInCalls('kortix_agents', { action: 'connect', slug: 'gmail' })).toEqual([]);
  });
});

describe('connectorSignInRequests', () => {
  const request = (slug: string, owner_type?: string, app = slug): SessionConnectRequest => ({
    slug,
    app,
    provider: 'composio',
    connected: false,
    ...(owner_type ? { owner_type, connection_id: `${slug}-${owner_type}` } : {}),
  });

  test('a call picks the request for its connector and the owner it asked for', () => {
    const mine = request('gmail', 'member');
    const shared = request('gmail', 'project');
    expect(connectorSignInRequests([mine, shared, request('notion', 'member')], [{ slug: 'gmail', owner: 'project' }])).toEqual([shared]);
    expect(connectorSignInRequests([mine, shared], [{ slug: 'gmail', owner: 'member' }])).toEqual([mine]);
  });

  test('without a request of that owner, every request of the connector is the call\'s', () => {
    const older = request('gmail');
    expect(connectorSignInRequests([older], [{ slug: 'gmail', owner: 'member' }])).toEqual([older]);
  });

  test('the call may name the provider app, in any case, with `-` for `_`', () => {
    const read = request('supabase-read', 'member', 'supabase_read_mcp');
    expect(connectorSignInRequests([read], [{ slug: 'SUPABASE-READ-MCP', owner: 'member' }])).toEqual([read]);
  });

  test('a request is listed once, in call order; a connector the session never asked for lists nothing', () => {
    const gmail = request('gmail', 'member');
    const slack = request('slack', 'member');
    const calls = [
      { slug: 'slack', owner: 'member' },
      { slug: 'gmail', owner: 'member' },
      { slug: 'slack', owner: 'member' },
    ] as const;
    expect(connectorSignInRequests([gmail, slack], calls)).toEqual([slack, gmail]);
    expect(connectorSignInRequests([gmail], [{ slug: 'linear', owner: 'member' }])).toEqual([]);
  });
});

describe('toolCallConnectorSignIns', () => {
  const block = (overrides: Partial<ToolCallBlock> = {}): ToolCallBlock => ({
    id: 'b1',
    type: 'tool_call',
    call_id: 'c1',
    name: 'bash',
    kind: 'bash',
    input: { command: 'kortix connectors connect notion --owner workspace' },
    status: 'complete',
    result: { content: [{ type: 'text', text: 'Open https://connect.example.test/link/x' }], is_error: false, exit_code: 0 },
    ...overrides,
  }) as ToolCallBlock;

  test('a call that ran cleanly started its sign-ins', () => {
    expect(toolCallConnectorSignIns(block())).toEqual([{ slug: 'notion', owner: 'project' }]);
    expect(toolCallConnectorSignIns(block({ result: undefined, status: 'running' }))).toEqual([{ slug: 'notion', owner: 'project' }]);
  });

  test('a call that failed started none: an error, an error result, or a shell exit other than 0', () => {
    expect(toolCallConnectorSignIns(block({ status: 'error' }))).toEqual([]);
    expect(toolCallConnectorSignIns(block({ result: { content: [], is_error: true } }))).toEqual([]);
    expect(toolCallConnectorSignIns(block({ result: { content: [], is_error: false, exit_code: 1 } }))).toEqual([]);
  });

  test('a `kortix_connectors` connect that returned `ok: false` started none; one that returned its link did', () => {
    const platform = (ok: boolean) =>
      block({
        name: 'kortix_connectors',
        kind: 'other',
        input: { action: 'connect', slug: 'googlecalendar' },
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok, tool: 'kortix_connectors', action: 'connect', card: { title: ok ? 'Sign in to googlecalendar' : 'Could not start the sign-in for googlecalendar', status: ok ? 'needs_you' : 'error' }, ...(ok ? {} : { error: { kind: 'not_found', message: 'Connector not found' } }) }) }],
          is_error: false,
        },
      });
    expect(toolCallConnectorSignIns(platform(false))).toEqual([]);
    expect(toolCallConnectorSignIns(platform(true))).toEqual([{ slug: 'googlecalendar', owner: 'member' }]);
  });
});
