// WHICH AGENT WILL RUN, AND MAY THIS CALLER RUN IT.
//
// Agents are deny-by-default for a project `member` (see
// iam/resource-grants.ts `isProjectResourceUsableByMember`). That rule is only
// worth anything if every path that STARTS work re-asks it about the agent that
// will actually run — including the path where the caller named no agent at all.
//
// The unnamed path is the one that bit us. A session created with no
// `agent_name` silently resolves to the manifest's `default_agent` (`kortix` in
// the starter, `kortix_permissions: all`, scoped to nobody). The composer showed no
// agent selected, the user typed a prompt, and that fully-privileged default
// answered it — an agent the member had never been granted. "No selection" is
// not "no agent"; it is the default agent, and it has to clear the same gate a
// named one does.
//
// NO MANIFEST READ ON THIS PATH. An earlier cut resolved the agent by calling
// `loadProjectAgents`, which reads kortix.yaml out of the repo over the git
// proxy. That made an authorization decision depend on a network read that
// legitimately fails (a project whose manifest is briefly unreadable reports
// zero declared agents), and it ran on EVERY prompt. A gate that answers
// "allowed" when the network hiccups is not a gate. Everything here comes from
// Postgres: the session row, the project's mirrored `default_agent`, and the
// memoized resource-grant map.

import { HTTPException } from 'hono/http-exception';
import { markAgentAccessDenial } from '../../shared/dead-credential-log';
import { filterAccessibleObjects, loadObjectGrants } from '../../iam/authorize';
import {
  actorForUser,
  credentialAgentGrant,
  credentialOnBehalfOf,
  isAgentPrincipalActor,
  type Actor,
} from '../../iam/actor';
import { agentDelegationAllowed } from '../../iam/agent-principal';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { spaceAccessFor } from '../../shared/space-access';
import { channelAgentNames, findSessionSpace } from './project-spaces';

// The request gates (`resolveAndAuthorizeAgent`, `assertMayRunAgent`)
// read the request's actor and on-behalf-of user, so they
// live in `http-agent-access.ts`. Re-exported here so every importer and mock
// keeps working.
export { resolveAndAuthorizeAgent, assertMayRunAgent } from './http-agent-access';

/** The non-binding sentinel meaning "whatever this project's default is". */
const DEFAULT_AGENT_SENTINEL = 'default';

const NO_AGENT_MESSAGE =
  "You don't have access to any agent in this project. Ask a manager to grant you one.";

/** An agent id no manifest can declare, used only to ask the fold "is this
 *  caller member-tier?" — it has no grants, so the fold returns it for a
 *  manager/owner/service account and drops it for a member. */
const TIER_PROBE_ID = '\0kortix.tier-probe';

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Treat the sentinel as "unnamed" — it selects the default, it is not an agent. */
function namedAgent(requested: unknown): string | null {
  const value = normalize(requested);
  return value && value !== DEFAULT_AGENT_SENTINEL ? value : null;
}

export interface ResolvedAgentAccess {
  /** The agent this caller will run, when it could be determined. */
  agentName: string | null;
  /** Every agent this caller may run. For a member that is exactly the set
   *  granted to them or their groups; for a manager/owner it also includes the
   *  unscoped ones among the candidates considered. */
  accessible: string[];
  /** True when this caller is subject to deny-by-default — i.e. a project
   *  `member`, not a manager/owner/service account. The create route uses it to
   *  decide whether `agentName` is BINDING: for a member it must be, or the
   *  session core's own resolution could still land on an agent this gate never
   *  approved. Only computed when the agent could not be resolved from the
   *  request/session/mirror; false otherwise. */
  memberTier: boolean;
  /** Allowed because the caller posts in the channel `spaceId` names, not by an agent grant. */
  viaChannel?: true;
}

/**
 * The agents a person may run in channel `spaceId` because they may post there
 * (owner decision 2026-10-26: channel members can post). A public channel and
 * `#general` let every project member post; a private one only its members
 * (`findSessionSpace` applies `canSeeSpace`). The channel's agents, or the
 * project default when it lists none. A DM, an archived or hidden channel, or
 * `chat` off: none, so the agent grants alone decide.
 */
async function channelRunnableAgents(
  loaded: { row: any; userId: string },
  projectId: string,
  spaceId: string | null | undefined,
  projectDefault: string | null,
): Promise<string[]> {
  if (!spaceId || !resolveFeatureFlag(loaded.row.metadata, 'chat')) return [];
  const space = await findSessionSpace(projectId, spaceId, await spaceAccessFor(projectId, loaded.userId, null));
  return space?.kind === 'channel' ? channelAgentNames(space, projectDefault) : [];
}

/**
 * Resolve the agent for a session/prompt and authorize it, or throw the 403 the
 * user can act on.
 *
 * Resolution order mirrors `resolveSessionAgentName` (projects/lib/sessions.ts):
 * an explicitly named agent wins, then the session's own stored agent, then the
 * project's mirrored `default_agent`.
 *
 * Authorization runs through `filterAccessibleObjects` — the SAME fold
 * that filters the agent list the composer renders — so what the UI offers and
 * what the server accepts cannot drift. It also carries every "who bypasses"
 * rule already: account owner/admins and service accounts get their candidates
 * back unfiltered, and a project manager keeps unscoped agents while still
 * being excluded from ones explicitly scoped to someone else.
 *
 * WHEN IT STAYS SILENT: if no agent could be resolved AND the project has no
 * agent grants at all, there is nothing to decide on, and it returns without
 * throwing rather than inventing a denial from missing data.
 */
export async function resolveAndAuthorizeAgentAs(
  /** The request's canonical principal, asked about the project's account. */
  actor: Actor,
  /** The request's fresh `onBehalfOfUserId` context value (undefined when unset). */
  requestOnBehalfOf: string | null | undefined,
  loaded: { row: any; userId: string },
  projectId: string,
  requestedAgent?: unknown,
  sessionAgent?: unknown,
  action = 'project.session.start',
  /** The channel the session is (or is being) filed in: its agents are open to whoever may post there. */
  spaceId?: string | null,
): Promise<ResolvedAgentAccess> {
  const project = loaded.row;
  const mirrored = normalize((project.metadata as Record<string, unknown> | null)?.default_agent);
  const resolved = namedAgent(requestedAgent) ?? namedAgent(sessionAgent) ?? mirrored ?? null;

  // Candidates = every agent someone has scoped in this project, plus the one
  // about to run. The grant map is the only list we need: an agent with no
  // grants is already inaccessible to a member by the deny-by-default rule, and
  // a manager/owner passes it through the fold untouched.
  // Agent-principal model (spec §2.2): the caller IS an agent, and its service
  // account bypasses object grants. Delegation is decided by the human it acts
  // for instead, or — with no human — restricted to the same agent.
  if (isAgentPrincipalActor(actor)) {
    return authorizeAgentDelegation(requestOnBehalfOf, actor, projectId, resolved, action);
  }
  if (resolved && spaceId) {
    const viaChannel = await channelRunnableAgents(loaded, projectId, spaceId, mirrored);
    // Binding (`memberTier`): the create route pins `agent_name`, so the agent
    // approved here is the one that runs. Connectors and secrets stay the
    // agent's own grants; posting widens only who may prompt it.
    if (viaChannel.includes(resolved)) return { agentName: resolved, accessible: viaChannel, memberTier: true, viaChannel: true };
  }
  // The candidate list comes from `role_assignments` — the same object-grant
  // memo `filterAccessibleObjects` decides on two lines down. Reading a second
  // store for the candidates and the canonical one for the verdict is how a
  // grant becomes invisible to the picker while still being enforced.
  const grants = await loadObjectGrants(projectId, 'agent');
  const candidates = [...new Set([...grants.keys(), ...(resolved ? [resolved] : [])])];
  if (candidates.length === 0) {
    // Nothing named an agent and the project scopes none — so there is no
    // resource to ask about, only a TIER to establish. Under deny-by-default a
    // project with zero agent grants has zero agents any member may run, while
    // a manager/owner/service account may run all of them. Probing the fold
    // with an id that cannot exist answers exactly that, reusing the one place
    // that knows who bypasses instead of re-deriving the rule here.
    const probe = await filterAccessibleObjects(actor, projectId, 'agent', [TIER_PROBE_ID]);
    if (probe.length === 0) throw denial(NO_AGENT_MESSAGE, 'no_agent_access', []);
    return { agentName: resolved, accessible: [], memberTier: false };
  }

  const accessible = await filterAccessibleObjects(actor, projectId, 'agent', candidates);

  if (accessible.length === 0) {
    throw denial(NO_AGENT_MESSAGE, 'no_agent_access', []);
  }
  if (!resolved) {
    // Nothing named the agent — no request field, no session row, no mirror —
    // but this caller does have agents. Report the first as the one to use; the
    // web pre-selects it for the same reason.
    //
    // For a MEMBER this answer has to be binding, so establish the tier. The
    // session core resolves the agent independently (manifest `default_agent`,
    // which this path could not read), and if it lands somewhere else the gate
    // approved one agent while another ran. `createSession` is handed
    // `agentName` for exactly this case — see the create route.
    const probe = await filterAccessibleObjects(actor, projectId, 'agent', [TIER_PROBE_ID]);
    return { agentName: accessible[0]!, accessible, memberTier: probe.length === 0 };
  }
  if (!accessible.includes(resolved)) {
    // Name the agent AND the way out. A member who holds a grant to a
    // non-default agent is one selection away from working — the web
    // pre-selects `accessible[0]` for exactly this case — but the server stays
    // strict so a direct API call cannot slip past onto the default.
    throw denial(
      `You don't have access to the ${resolved} agent — pick one of: ${accessible.join(', ')}.`,
      'agent_not_accessible',
      accessible,
    );
  }
  return { agentName: resolved, accessible, memberTier: false };
}

/**
 * An agent-session credential starts or prompts a session of agent `target`.
 * Requires run(on_behalf_of, target); with no human on behalf of, only
 * `target == the caller's own agent`. Spec §2.2 (closes V4: the SA bypassed
 * object grants, so an agent could start agents its human may not run).
 */
async function authorizeAgentDelegation(
  requestOnBehalfOf: string | null | undefined,
  actor: Actor,
  projectId: string,
  target: string | null,
  action: string,
): Promise<ResolvedAgentAccess> {
  const parentAgent = credentialAgentGrant(actor)?.agent ?? '';
  if (!target) {
    throw denial('An agent session must name the agent it starts.', 'agent_not_accessible', [], action);
  }
  // The auth middleware reads on_behalf_of fresh on every request; the actor's
  // copy comes from the 15 s token-binding memo. Prefer the fresh value.
  const fresh = requestOnBehalfOf;
  const onBehalfOfUserId = fresh !== undefined ? fresh : credentialOnBehalfOf(actor);
  const humanMayRunTarget = onBehalfOfUserId
    ? (await filterAccessibleObjects(actorForUser(onBehalfOfUserId, actor.accountId), projectId, 'agent', [target]))
        .length > 0
    : false;
  if (!agentDelegationAllowed({ parentAgent, target, onBehalfOfUserId, humanMayRunTarget })) {
    throw denial(
      onBehalfOfUserId
        ? `Agent "${parentAgent}" cannot start the ${target} agent: the person it acts for may not run ${target}.`
        : `Agent "${parentAgent}" runs without a person behind it and may start only another ${parentAgent} session.`,
      'agent_not_accessible',
      [],
      action,
    );
  }
  return { agentName: target, accessible: [target], memberTier: false };
}

/**
 * May the caller run agent `agentName`? Throws `403 agent_not_accessible`
 * naming `action` when not. For entry points that do not create the session
 * themselves but cause one to run the agent — a manual trigger fire (spec
 * 2026-09-22 §2.2, closes V2). An agent-session caller follows the delegation
 * rule; a human follows the agent object grants.
 */
export async function assertActorMayRunAgent(
  actor: Actor,
  requestOnBehalfOf: string | null | undefined,
  projectId: string,
  agentName: string,
  action: string,
): Promise<void> {
  if (isAgentPrincipalActor(actor)) {
    await authorizeAgentDelegation(requestOnBehalfOf, actor, projectId, agentName, action);
    return;
  }
  const accessible = await filterAccessibleObjects(actor, projectId, 'agent', [agentName]);
  if (accessible.length === 0) {
    throw denial(`You don't have access to the ${agentName} agent.`, 'agent_not_accessible', [], action);
  }
}

/** The 403. `code` + `accessible_agents` let the web pre-select a usable agent
 *  instead of only showing the message; the SDK's ApiError already lifts `code`. */
function denial(
  message: string,
  code: string,
  accessible: string[],
  action = 'project.session.start',
): HTTPException {
  const err = new HTTPException(403, {
    message,
    res: new Response(
      JSON.stringify({ error: message, message, code, action, accessible_agents: accessible }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  });
  // The refusal is designed (the deny-by-default gate) and the body above names
  // the remedy, so the LINE goes through the shared refusal throttle (KRTX-4800);
  // the response ships untouched every time.
  markAgentAccessDenial(err);
  return err;
}
