import { expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { callPolicySetOf, connectorDenialBody, principalMayUseConnector } from './principal-access';

const narrow: AgentGrant = {
  agent: 'release-bot',
  connectors: ['github'],
  permissions: [],
  env: [],
  manifestRevision: 'd'.repeat(40),
  manifestCommit: 'b'.repeat(40),
};

test('a null grant is unrestricted', () => {
  expect(principalMayUseConnector({ agentGrant: null }, 'stripe')).toBe(true);
});

test('a narrow grant denies everything it does not list', () => {
  expect(principalMayUseConnector({ agentGrant: narrow }, 'github')).toBe(true);
  expect(principalMayUseConnector({ agentGrant: narrow }, 'stripe')).toBe(false);
  expect(principalMayUseConnector({ agentGrant: { ...narrow, connectors: [] } }, 'github')).toBe(false);
});

test("the session's originating channel connector is reachable under ANY grant, and only that one", () => {
  const p = { agentGrant: { ...narrow, connectors: [] as string[] }, channelConnectorSlugs: ['kortix_slack'] };
  expect(principalMayUseConnector(p, 'kortix_slack')).toBe(true);
  expect(principalMayUseConnector(p, 'kortix_email')).toBe(false);
  expect(principalMayUseConnector(p, 'stripe')).toBe(false);
  expect(principalMayUseConnector({ agentGrant: narrow, channelConnectorSlugs: [] }, 'kortix_slack')).toBe(false);
});

test('a spawn child inherits a connector its parent holds (KRTX-4643)', () => {
  const parent: AgentGrant = {
    agent: 'coordinator',
    connectors: ['kortix_slack'],
    permissions: [],
    env: [],
    manifestRevision: 'e'.repeat(40),
    manifestCommit: 'f'.repeat(40),
  };
  const child = { agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [parent] };
  expect(principalMayUseConnector(child, 'kortix_slack')).toBe(true);
  expect(principalMayUseConnector(child, 'github')).toBe(false);
  expect(principalMayUseConnector(child, 'stripe')).toBe(false);
});

// A null entry is an ANCESTOR WHOSE GRANT IS GONE (its token was revoked or its
// session deleted): it hands nothing down — the inverse of the caller's own
// null grant, which means an ungoverned project. Fail closed.
test('an unreadable ancestor grant hands nothing down', () => {
  expect(principalMayUseConnector({ agentGrant: narrow, inheritedGrants: [null] }, 'stripe')).toBe(false);
  expect(principalMayUseConnector({ agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [null] }, 'kortix_slack')).toBe(false);
  expect(callPolicySetOf({ agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [null] }, 'stripe')).toBeNull();
});

test('a null entry is skipped, not a stop: a farther ancestor still hands its grant down', () => {
  const parent: AgentGrant = { ...narrow, agent: 'coordinator', connectors: ['kortix_slack'] };
  expect(principalMayUseConnector({ agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [null, parent] }, 'kortix_slack')).toBe(true);
});

test('an inherited call answers to the nearest ancestor that reaches the connector, null entries skipped', () => {
  const parent: AgentGrant = { ...narrow, agent: 'coordinator', connectors: ['kortix_slack'], policySets: { kortix_slack: 'writes' } };
  expect(callPolicySetOf({ agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [null, parent] }, 'kortix_slack')).toEqual({
    name: 'writes',
    agent: 'coordinator',
    manifestCommit: 'b'.repeat(40),
  });
});

test('inherited grants alone do not widen a caller whose own grant already reaches a connector', () => {
  const parent: AgentGrant = { ...narrow, connectors: ['github'] };
  expect(principalMayUseConnector({ agentGrant: narrow, inheritedGrants: [parent] }, 'github')).toBe(true);
});

test('an inherited call runs under the nearest ancestor policy set that reaches the connector', () => {
  const near: AgentGrant = { ...narrow, agent: 'coordinator', connectors: ['kortix_slack'], policySets: { kortix_slack: 'read_only' } };
  const far: AgentGrant = { ...narrow, agent: 'root-agent', connectors: ['kortix_slack', 'github'], policySets: { kortix_slack: 'writes' } };
  // The parent's own grant reaches the connector: its set or the base rules win, never a farther ancestor's.
  expect(callPolicySetOf({ agentGrant: near, inheritedGrants: [far] }, 'kortix_slack')).toEqual({
    name: 'read_only',
    agent: 'coordinator',
    manifestCommit: 'b'.repeat(40),
  });
  // The child's own grant does not reach it: the nearest ancestor that does names the set.
  const child = { agentGrant: { ...narrow, connectors: [] as string[] }, inheritedGrants: [near, far] };
  expect(callPolicySetOf(child, 'kortix_slack')).toEqual({ name: 'read_only', agent: 'coordinator', manifestCommit: 'b'.repeat(40) });
  // A nearer ancestor that reaches the connector without a set stops the walk: base rules, exactly its own calls.
  const bare: AgentGrant = { ...narrow, agent: 'middle', connectors: ['kortix_slack'] };
  expect(callPolicySetOf({ agentGrant: child.agentGrant, inheritedGrants: [bare, far] }, 'kortix_slack')).toBeNull();
});

test('a channel call still runs the base rules when no inherited grant carries a set', () => {
  const parent: AgentGrant = { ...narrow, agent: 'coordinator', connectors: [] };
  const p = { agentGrant: { ...narrow, connectors: [] as string[] }, channelConnectorSlugs: ['kortix_slack'], inheritedGrants: [parent] };
  expect(principalMayUseConnector(p, 'kortix_slack')).toBe(true);
  expect(callPolicySetOf(p, 'kortix_slack')).toBeNull();
});

test('connector_not_assigned tells the agent never to retry through another spawn (KRTX-4643)', () => {
  const body = connectorDenialBody('connector_not_assigned', {
    principal: { agentGrant: narrow },
    connector: 'stripe',
  });
  expect(String(body.hint)).toContain('Do not start another agent');
});

test('connector_not_assigned names the agent, what it holds, and the manifest it came from', () => {
  const body = connectorDenialBody('connector_not_assigned', {
    principal: { agentGrant: narrow },
    connector: 'stripe',
    action: 'list_customers',
  });
  expect(body).toMatchObject({
    ok: false,
    status: 'denied',
    reason: 'connector_not_assigned',
    connector: 'stripe',
    action: 'list_customers',
    agent: 'release-bot',
    granted: ['github'],
    manifest_revision: 'd'.repeat(40),
    manifest_commit: 'b'.repeat(40),
  });
  expect(String(body.hint)).toContain('agents.release-bot.connectors');
});

test('each denial reason carries a stable code and a hint', () => {
  for (const reason of [
    'connector_not_found',
    'connector_not_connected',
    'connector_disabled',
    'action_not_found',
    'account_required',
  ] as const) {
    const body = connectorDenialBody(reason, { connector: 'heyreach_api', action: 'check_api_key' });
    expect(body.reason).toBe(reason);
    expect(body.ok).toBe(false);
    expect(typeof body.hint).toBe('string');
    expect(String(body.hint).length).toBeGreaterThan(20);
  }
  expect(String(connectorDenialBody('connector_not_connected', { connector: 'heyreach_api' }).hint)).toContain(
    'kortix connectors connect heyreach_api',
  );
});

/**
 * THE RULE: several accounts reachable, none named, none pinned → denied
 * `account_required`, never a silent guess. The body must name every
 * available account and say how to fix it (name one, or pin one).
 */
test('account_required names every available account and how to fix it', () => {
  const body = connectorDenialBody('account_required', {
    connector: 'gmail',
    action: 'send_message',
    availableAccounts: ['Work', 'Personal'],
  });
  expect(body).toMatchObject({
    ok: false,
    status: 'denied',
    reason: 'account_required',
    connector: 'gmail',
    action: 'send_message',
    available_accounts: ['Work', 'Personal'],
    default_account: null,
  });
  expect(String(body.hint)).toContain('account:<label|id|me|project>');
  expect(String(body.hint)).toContain('gmail');
  expect(String(body.hint)).toContain('kortix connectors accounts gmail --default');
});

test('account_required with no available accounts still carries a usable hint', () => {
  const body = connectorDenialBody('account_required', { connector: 'gmail' });
  expect(body.available_accounts).toEqual([]);
  expect(body.default_account).toBeNull();
});

/**
 * An account exists on the connector but this caller cannot reach it. Telling
 * the agent "no credential stored, start a sign-in" made it add a duplicate
 * account. The denial names the real remedy and offers no sign-in link.
 */
test('connector_not_shared names the agent, the remedy, and never a sign-in link', () => {
  const body = connectorDenialBody('connector_not_shared', {
    principal: { agentGrant: { ...narrow, agent: 'support' } },
    connector: 'gmail',
    action: 'send_message',
    connectUrl: 'https://example.test/connect/should-not-appear',
  });
  expect(body).toMatchObject({ ok: false, status: 'denied', reason: 'connector_not_shared', connector: 'gmail' });
  expect(body).not.toHaveProperty('connect_url');
  const hint = String(body.hint);
  expect(hint).toContain('agent "support"');
  expect(hint).toContain('Settings → Connectors');
  expect(hint).toContain('Do not start a new sign-in');
  expect(hint).not.toContain('kortix connectors connect');

  const sessionOnly = String(connectorDenialBody('connector_not_shared', { connector: 'gmail' }).hint);
  expect(sessionOnly).toContain('this session');
});
