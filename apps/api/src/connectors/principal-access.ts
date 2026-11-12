/**
 * The ONE connector access predicate for a connector principal.
 *
 * Three inputs decide whether a principal may reach a connector:
 *
 *   1. The agent grant on its session token (`agentMayUseConnector`) — the
 *      per-agent `connectors:` list from `kortix.yaml`.
 *   2. The session's ORIGINATING CHANNEL. A session that Slack (or Teams, or
 *      email) created exists to answer on that channel; the channel connector
 *      is the agent's only way to report anything — including that its other
 *      connectors are gone. It is therefore reachable regardless of the grant.
 *      INC-2026-09-08-CONNECTOR-GATEWAY: a grant that collapsed to `[]` took
 *      the Slack connector down with everything else and left the agent mute.
 *   3. The SPAWN LINE. A session spawned by another session (a subagent: a
 *      built-in, a fork, an inline colleague, a named agent) exists to do its
 *      parent's work with the tools the parent handed it, so it inherits what
 *      the line above it could reach (KRTX-4643): the ancestors' stored agent
 *      grants, nearest parent first (`inheritedGrants`). A delegate never
 *      reaches more than its parent — every entry is a grant the parent's own
 *      calls run under.
 *
 * The channel allowance is deliberately narrow: only the channel connector(s)
 * for the platform that created THIS session or an ancestor, resolved
 * server-side from `project_sessions.metadata.source` — never from the
 * request.
 */
import type { AgentGrant } from '@kortix/db';
import { isMyKortixAgentName } from '@kortix/shared';
import { agentMayUseConnector, agentPolicySet } from '../iam/agent-scope';
import { canonicalConnectorAlias } from '../shared/connector-alias';
import type { CallPolicySet } from './gateway';

export interface ConnectorAccessPrincipal {
  agentGrant?: AgentGrant | null;
  /** Canonical slugs of the channel connector(s) that created this session. */
  channelConnectorSlugs?: readonly string[];
  /** The stored agent grant of every ancestor on this session's spawn line,
   *  nearest parent first (see `sessionConnectorLineage`). */
  inheritedGrants?: readonly (AgentGrant | null)[];
}

/** `slug` MUST be canonical (`canonicalConnectorAlias`). */
export function principalMayUseConnector(
  principal: ConnectorAccessPrincipal,
  slug: string,
): boolean {
  if (agentMayUseConnector(principal.agentGrant ?? null, slug)) return true;
  if (principal.channelConnectorSlugs?.includes(slug)) return true;
  // An ancestor entry that could not be read (its token was revoked or its
  // session deleted) is no grant, not "no restriction": it hands nothing
  // down. Only the caller's OWN null grant means an ungoverned project.
  return (principal.inheritedGrants ?? []).some((grant) => grant != null && agentMayUseConnector(grant, slug));
}

/**
 * The policy set the caller runs under on this connector. The reconciled
 * session grant on the principal decides: the caller's own grant when it
 * reaches the connector (its set, else the base rules), else the nearest
 * inherited grant that reaches it — an inherited call answers to the same set
 * its parent's own calls answer to. A caller without a grant (PAT, dashboard,
 * trigger poll) gets the base rules. The request body never selects a set.
 * The `/call` route and the held-call run both use it.
 */
export function callPolicySetOf(
  p: Pick<ConnectorAccessPrincipal, 'agentGrant' | 'inheritedGrants'>,
  connectorSlug: string,
): CallPolicySet | null {
  const slug = canonicalConnectorAlias(connectorSlug);
  const grant = p.agentGrant ?? null;
  if (grant && agentMayUseConnector(grant, slug)) {
    const name = agentPolicySet(grant, slug);
    return name === null ? null : { name, agent: grant.agent, manifestCommit: grant.manifestCommit ?? null };
  }
  for (const inherited of p.inheritedGrants ?? []) {
    if (!inherited || !agentMayUseConnector(inherited, slug)) continue;
    const name = agentPolicySet(inherited, slug);
    return name === null ? null : { name, agent: inherited.agent, manifestCommit: inherited.manifestCommit ?? null };
  }
  return null;
}

export type ConnectorDenialReason =
  | 'connector_not_assigned'
  | 'connector_not_found'
  | 'connector_not_connected'
  /**
   * An account on the connector is signed in, but this caller (its agent, its
   * session) cannot reach it. Not `connector_not_connected`: a new sign-in
   * would only add a duplicate account. The account's owner shares it.
   */
  | 'connector_not_shared'
  | 'connector_disabled'
  | 'action_not_found'
  /**
   * THE RULE (2026-09-16): several accounts are reachable, none was named,
   * and none is pinned. A silent tie-break here is a guess with real
   * consequences (mail from the wrong mailbox) — the call is denied instead,
   * naming every account the caller could pass or pin.
   */
  | 'account_required';

/**
 * The body a denied call answers with. `reason` is the stable machine code the
 * CLI/MCP surface already keys on; the rest is what an agent needs to fix or
 * escalate the denial instead of guessing (action item 5 of the incident):
 * which agent was checked, what it holds, which manifest revision that came
 * from, and one sentence on what to do.
 */
export function connectorDenialBody(
  reason: ConnectorDenialReason,
  input: {
    principal?: ConnectorAccessPrincipal;
    connector: string;
    action?: string | null;
    /**
     * A hosted authorization link for `connector_not_connected`, when one can
     * be built for this connector and caller.
     *
     * The agent surfaces it verbatim and the web transcript turns a
     * `/connect/<token>` url into the one-click Connect button
     * (`parseSetupLinkHref` → `SetupLinkButton`). This is the whole remedy for
     * an unconnected connector: the turn is no longer refused up front, so the
     * denial itself has to carry the fix.
     */
    connectUrl?: string | null;
    /** The account name the caller asked to run as, when it named one. */
    requestedAccount?: string | null;
    /** The account names that WERE available, so the retry can be right. */
    availableAccounts?: readonly string[];
    /** `action_not_found`: the connector's closest action paths, best first. */
    suggestions?: readonly string[];
  },
): Record<string, unknown> {
  const grant = input.principal?.agentGrant ?? null;
  const base = {
    ok: false as const,
    status: 'denied' as const,
    reason,
    connector: input.connector,
    ...(input.action ? { action: input.action } : {}),
  };
  switch (reason) {
    case 'connector_not_assigned':
      return {
        ...base,
        agent: grant?.agent ?? null,
        granted: grant ? grant.connectors : 'all',
        manifest_revision: grant?.manifestRevision ?? null,
        manifest_commit: grant?.manifestCommit ?? null,
        hint: !grant
          ? `Connector "${input.connector}" is not assigned to this principal.`
          : isMyKortixAgentName(grant.agent)
            // A session minted before My Kortix held every connector: its next prompt re-mints the grant.
            ? `This session's grant predates My Kortix holding every connector. Send another message so the session re-reads its grant, then call "${input.connector}" again. Do not start another agent for this call.`
            : `Agent "${grant.agent}" is not granted connector "${input.connector}". Add it to agents.${grant.agent}.connectors in kortix.yaml (or set connectors: "*"), then send another message so the session re-reads the manifest. Do not start another agent for this call: a spawned session inherits the spawning session's connectors, so every delegate is denied the same way. Do the work in a session that holds the connector, or tell the human.`,
      };
    case 'connector_not_connected': {
      // Three different situations behind one reason, and naming the wrong one
      // sends the agent (and the human) down the wrong remedy.
      const named = input.requestedAccount?.trim();
      const available = input.availableAccounts ?? [];
      if (named && available.length > 0) {
        return {
          ...base,
          requested_account: named,
          available_accounts: [...available],
          hint:
            `Connector "${input.connector}" has no account named "${named}". ` +
            `Available: ${available.map((name) => `"${name}"`).join(', ')}. ` +
            `Retry with one of those, or omit \`account\` for the default.`,
        };
      }
      return {
        ...base,
        ...(input.connectUrl ? { connect_url: input.connectUrl } : {}),
        ...(named ? { requested_account: named } : {}),
        hint: input.connectUrl
          ? `Connector "${input.connector}" has no connected account yet. Give the human this link so they can authorize it, then retry: ${input.connectUrl}`
          : `Connector "${input.connector}" exists in this project but has no usable connection for this session: no credential is stored, or the app was never authorized. Run \`kortix connectors connect ${input.connector}\` or add its credential, then retry.`,
      };
    }
    case 'connector_not_shared': {
      // No `connect_url`: a sign-in here only adds a duplicate account.
      const agent = grant?.agent ?? null;
      // My Kortix acts as the person, so the person is who it is shared with.
      const audience = agent && !isMyKortixAgentName(agent) ? `agent "${agent}"` : 'this session';
      const target = agent && !isMyKortixAgentName(agent) ? `agent "${agent}"` : 'you';
      return {
        ...base,
        ...(input.requestedAccount?.trim() ? { requested_account: input.requestedAccount.trim() } : {}),
        hint:
          `Connector "${input.connector}" has a signed-in account, but it is not shared with ${audience}. ` +
          `Ask the account's owner (a workspace admin for a shared account) to share it with ${target} or the workspace ` +
          `in Settings → Connectors → ${input.connector}, then retry. Do not start a new sign-in: it adds a duplicate account.`,
      };
    }
    case 'account_required':
      return {
        ...base,
        available_accounts: [...(input.availableAccounts ?? [])],
        default_account: null,
        hint:
          `Several accounts are connected to "${input.connector}"; pass ` +
          `account:<label|id|me|project>, or pin one with \`kortix connectors ` +
          `accounts ${input.connector} --default <label>\`.`,
      };
    case 'connector_disabled':
      return {
        ...base,
        hint: `Connector "${input.connector}" is declared but disabled in this project.`,
      };
    case 'connector_not_found':
      return {
        ...base,
        hint: `No connector "${input.connector}" is declared in this project's kortix.yaml. Run \`kortix connectors ls\` to see what exists, or \`kortix connectors add\` to declare it.`,
      };
    case 'action_not_found': {
      const suggestions = input.suggestions ?? [];
      const list = `Run \`kortix connectors show ${input.connector}\` to list its actions.`;
      return {
        ...base,
        ...(suggestions.length > 0 ? { did_you_mean: [...suggestions] } : {}),
        hint:
          suggestions.length > 0
            ? `Unknown action ${input.action ?? ''} on connector "${input.connector}". Did you mean ` +
              `${suggestions.map((path) => `${input.connector}.${path}`).join(', ')}? ` +
              `Call it as \`kortix connectors call ${input.connector} ${suggestions[0]}\`. ${list}`
            : `Connector "${input.connector}" has no action "${input.action ?? ''}". ${list}`,
      };
    }
  }
}
