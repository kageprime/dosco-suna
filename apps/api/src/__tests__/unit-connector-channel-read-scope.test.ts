/**
 * The gateway and the `/call` route apply the Slack read and write gates
 * (connectors/slack-visibility.ts, channel-write-scope.ts) in the right order:
 *   - a call from a Kortix workspace that does not hold the Slack workspace,
 *     or a read of a private conversation the person is not in, is denied
 *     before the credential, the approval gate or the provider, and audited;
 *   - the answer reaches the agent only after the gate filtered it;
 *   - the HTTP body carries `reason` for code and `message` for the agent.
 * Fakes only: the link rows are proven in integration-channel-write-scope.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { gateChannelRead } from '../connectors/channel-read-scope';
import { gateChannelWrite } from '../connectors/channel-write-scope';
import { SLACK_CHANNEL_CONNECTOR_SLUG } from '../connectors/channels';
import { SLACK_NOT_LINKED, SLACK_PRIVATE_CONVERSATION, type SlackReadDeps } from '../connectors/slack-visibility';
import {
  type CallInput,
  type ExecutionRecord,
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  handleCall,
} from '../connectors/gateway';
import { type ConnectorPrincipal, type ConnectorRouterDeps, createConnectorRouter } from '../connectors/router';

const MINE = 'proj-mine';

const SLACK: GatewayConnector = {
  connectorId: 'conn-slack',
  slug: SLACK_CHANNEL_CONNECTOR_SLUG,
  provider: 'channel',
  platform: 'slack',
  baseUrl: 'https://slack.com/api',
  auth: { type: 'bearer', in: 'header', name: null, prefix: null },
  hasAuth: true,
  credentialMode: 'shared',
  enabled: true,
};

function action(relPath: string, method: string, risk: 'read' | 'write' = 'read'): GatewayAction {
  return {
    path: `${SLACK_CHANNEL_CONNECTOR_SLUG}.${relPath}`,
    relPath,
    inputSchema: { type: 'object', properties: { channel: {}, ts: {} } },
    risk,
    binding: { kind: 'http', method: risk === 'read' ? 'GET' : 'POST', path: `/${method}` },
  };
}

/** The linked Slack workspace: G0EXEC is private and the session's person is not in it. */
function slackFor(linked: boolean): SlackReadDeps {
  return {
    link: async () => (linked ? { teamId: 'T0WS' } : null),
    view: async () => ({ privateIds: new Set(['G0EXEC']), allowedIds: new Set(), hasPerson: true }),
  };
}

function deps(opts: {
  action: GatewayAction;
  body: string;
  credential?: () => Promise<string | null>;
  /** Wire the write gate too, as db-deps.ts does. */
  writes?: boolean;
  /** This Kortix workspace holds the Slack workspace's link (default true). */
  linked?: boolean;
}) {
  const linked = opts.linked ?? true;
  const fetched: string[] = [];
  const audits: ExecutionRecord[] = [];
  const credentialReads: string[] = [];
  const binds: string[] = [];
  const d: GatewayDeps = {
    loadConnectorBySlug: async () => SLACK,
    loadAction: async () => opts.action,
    resolveCredential: async (c) => {
      credentialReads.push(c.connectorId);
      return opts.credential ? opts.credential() : 'xoxb-shared-workspace-token';
    },
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async (rec) => {
      audits.push(rec);
      return null;
    },
    gateChannelRead: (input) => gateChannelRead(input, undefined, slackFor(linked)),
    ...(opts.writes
      ? {
          gateChannelWrite: (input: Parameters<typeof gateChannelWrite>[0]) =>
            gateChannelWrite(input, async () => (linked ? 'linked' : 'not_linked'), slackFor(linked)),
        }
      : {}),
    bindSlackThread: async (i) => {
      binds.push(`${i.channel}/${i.threadTs}`);
      return { bound: true, thread_ts: i.threadTs, session_id: i.sessionId };
    },
    fetchImpl: async (url) => {
      fetched.push(url);
      return { status: 200, ok: true, text: async () => opts.body };
    },
  };
  return { deps: d, fetched, audits, credentialReads, binds };
}

const call = (actionPath: string, args: Record<string, unknown>): CallInput => ({
  projectId: MINE,
  accountId: 'acct-1',
  subject: { userId: 'user-1', groupIds: [] },
  sessionId: 'sess-1',
  connectorSlug: SLACK_CHANNEL_CONNECTOR_SLUG,
  actionPath,
  args,
});

describe('handleCall — Slack reads', () => {
  test('a Kortix workspace that does not hold the Slack workspace is denied before the credential and the provider, and audited', async () => {
    const { deps: d, fetched, audits, credentialReads } = deps({
      action: action('get_history', 'conversations.history'),
      body: '{"ok":true,"messages":[{"ts":"1.1","text":"secret"}]}',
      linked: false,
    });
    const res = await handleCall(d, call('get_history', { channel: 'C0PUBLIC' }));
    expect(res).toMatchObject({ status: 'denied', reason: SLACK_NOT_LINKED });
    expect(fetched).toEqual([]);
    expect(credentialReads).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      projectId: MINE,
      status: 'denied',
      actionPath: `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_history`,
      resultSummary: { reason: SLACK_NOT_LINKED },
    });
  });

  test('a public channel reaches Slack, and the agent gets all of it', async () => {
    const body = { ok: true, messages: [{ ts: '200.2', text: 'ours' }, { ts: '100.1', thread_ts: '100.1', text: 'a thread' }] };
    const { deps: d, fetched } = deps({ action: action('get_history', 'conversations.history'), body: JSON.stringify(body) });
    const res = await handleCall(d, call('get_history', { channel: 'C0PUBLIC' }));
    expect(fetched).toEqual(['https://slack.com/api/conversations.history?limit=20&channel=C0PUBLIC']);
    expect(res).toMatchObject({ status: 'ok', data: body });
  });

  test("a private conversation the person is not in is denied before the provider; on an answer, nothing of it is returned", async () => {
    const history = deps({ action: action('get_history', 'conversations.history'), body: '{"ok":true,"messages":[]}' });
    expect(await handleCall(history.deps, call('get_history', { channel: 'G0EXEC' }))).toMatchObject({
      status: 'denied',
      reason: SLACK_PRIVATE_CONVERSATION,
    });
    expect(history.fetched).toEqual([]);

    const info = deps({
      action: action('channel_info', 'conversations.info'),
      body: '{"ok":true,"channel":{"id":"G0EXEC","is_private":true,"name":"exec-secret"}}',
    });
    const res = await handleCall(info.deps, call('channel_info', { channel: 'G0EXEC' }));
    expect(info.fetched).toHaveLength(1);
    expect(res).toMatchObject({ status: 'denied', reason: SLACK_PRIVATE_CONVERSATION });
    expect(JSON.stringify(res)).not.toContain('exec-secret');
    expect(info.audits.map((a) => a.status)).toEqual(['denied']);
  });

  test('the read gate leaves a write to the write gate', async () => {
    const { deps: d, fetched } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0PUBLIC"}',
      linked: false,
    });
    const res = await handleCall(d, { ...call('send_message', { channel: 'C0PUBLIC', text: 'hi' }), sessionId: null });
    expect(res.status).toBe('ok');
    expect(fetched).toEqual(['https://slack.com/api/chat.postMessage']);
  });
});

describe('handleCall — Slack writes', () => {
  test('a Kortix workspace that does not hold the Slack workspace is denied before the credential, the provider and the thread bind', async () => {
    const { deps: d, fetched, audits, credentialReads, binds } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0PUBLIC"}',
      writes: true,
      linked: false,
    });
    const res = await handleCall(d, call('send_message', { channel: 'C0PUBLIC', text: 'hi' }));
    expect(res).toMatchObject({ status: 'denied', reason: SLACK_NOT_LINKED });
    expect(fetched).toEqual([]);
    expect(credentialReads).toEqual([]);
    expect(binds).toEqual([]);
    expect(audits.map((a) => [a.status, (a.resultSummary as { reason?: string }).reason])).toEqual([['denied', SLACK_NOT_LINKED]]);
  });

  test('the linked Kortix workspace posts anywhere its bot may, and the thread binds to the session', async () => {
    const { deps: d, fetched, binds } = deps({
      action: action('send_message', 'chat.postMessage', 'write'),
      body: '{"ok":true,"ts":"300.3","channel":"C0ANY00001"}',
      writes: true,
    });
    const res = await handleCall(d, call('send_message', { channel: 'C0ANY00001', text: 'done' }));
    expect(res).toMatchObject({ status: 'ok', data: { thread_binding: { bound: true, thread_ts: '300.3' } } });
    expect(fetched).toEqual(['https://slack.com/api/chat.postMessage']);
    expect(binds).toEqual(['C0ANY00001/300.3']);
  });
});

describe('POST /call — the denial body', () => {
  test('403 with the stable reason and the sentence the agent reads', async () => {
    const { deps: gatewayDeps, fetched } = deps({
      action: action('get_thread', 'conversations.replies'),
      body: '{"ok":true,"messages":[]}',
    });
    const principal = {
      userId: 'user-1',
      accountId: 'acct-1',
      projectId: MINE,
      sessionId: null,
      subject: { userId: 'user-1', groupIds: [] },
    } as ConnectorPrincipal;
    const routerDeps = {
      featureFlagEnabled: async () => true,
      resolvePrincipal: async () => principal,
      resolveProjectPrincipal: async () => principal,
      makeGatewayDeps: () => gatewayDeps,
    } as unknown as ConnectorRouterDeps;
    const res = await createConnectorRouter(routerDeps).fetch(
      new Request('http://x/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connector: SLACK_CHANNEL_CONNECTOR_SLUG,
          action: 'get_thread',
          args: { channel: 'G0EXEC', ts: '100.1' },
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      status: 'denied',
      reason: SLACK_PRIVATE_CONVERSATION,
      message:
        'Slack conversation G0EXEC is private, and the person this session works for is not in it. A private channel or DM is readable only by a session of someone in it.',
    });
    expect(fetched).toEqual([]);
  });
});
