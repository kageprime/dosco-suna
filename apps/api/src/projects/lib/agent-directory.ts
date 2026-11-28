// The agent directory (flag `channels`): the workspace's agents a person can
// message, each with the person's own chat. An entry is an agent from kortix.yaml; this file
// adds no table. The chat is the person's DM space with the agent
// (`project_spaces`, kind `dm`), created on first open by `getOrCreateDm`.
import type { AgentDirectoryEntry } from '@kortix/api-contract';
import { projectSessions, projectSpaces } from '@kortix/db';
import { MY_KORTIX_AGENT_NAME, MY_KORTIX_DISPLAY_NAME, isMyKortixAgentName } from '@kortix/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import type { LoadedAgents } from '../agents/types';
import { abortRuntimeTurn } from '../session-lifecycle/abort-runtime-turn';
import { projectsView, updateProjectRowsReturning } from '../../workspaces/rows';

/**
 * The agent directory of a project, in manifest order, My Kortix first when the
 * project runs it. A `mode: subagent` agent is not listed: a person cannot message it.
 * An agent that cannot start (`enabled: false` or a block with an error) is
 * listed with status `off`, so the sidebar can say why it does not answer.
 *
 * Pure. `dmByAgent` maps an agent name to the caller's DM space id.
 */
export function agentDirectoryFromAgents(loaded: LoadedAgents, dmByAgent: ReadonlyMap<string, string>, paused: ReadonlySet<string> = new Set()): AgentDirectoryEntry[] {
  const entries: AgentDirectoryEntry[] = [];
  const status = (name: string, enabled: boolean): AgentDirectoryEntry['status'] => (!enabled ? 'off' : paused.has(name) ? 'paused' : 'active');
  const defaultAgent = loaded.defaultAgent ?? null;
  if (loaded.builtinAgents?.my_kortix === true) {
    entries.push({
      name: MY_KORTIX_AGENT_NAME,
      display_name: MY_KORTIX_DISPLAY_NAME,
      model: null,
      status: status(MY_KORTIX_AGENT_NAME, true),
      is_default: defaultAgent === MY_KORTIX_AGENT_NAME,
      builtin: true,
      chat_space_id: dmByAgent.get(MY_KORTIX_AGENT_NAME) ?? null,
    });
  }
  for (const spec of loaded.specs) {
    if (spec.subagent) continue;
    if (spec.name === MY_KORTIX_AGENT_NAME) continue;
    entries.push({
      name: spec.name,
      display_name: spec.name,
      model: spec.model,
      status: status(spec.name, spec.enabled),
      is_default: defaultAgent === spec.name,
      builtin: false,
      chat_space_id: dmByAgent.get(spec.name) ?? null,
    });
  }
  return entries;
}

/** The caller's live DM space per agent name. */
export async function dmSpacesByAgent(projectId: string, userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ spaceId: projectSpaces.spaceId, agent: projectSpaces.dmAgentName })
    .from(projectSpaces)
    .where(
      and(
        eq(projectSpaces.projectId, projectId),
        eq(projectSpaces.kind, 'dm'),
        eq(projectSpaces.dmUserId, userId),
        isNull(projectSpaces.archivedAt),
      ),
    );
  const out = new Map<string, string>();
  for (const row of rows) if (row.agent) out.set(row.agent, row.spaceId);
  return out;
}

/** The project's metadata key that holds the paused agents' names. */
export const PAUSED_AGENTS_KEY = 'paused_agents';

/** The agent names paused in a project's metadata. Pure. */
export function pausedAgents(metadata: unknown): Set<string> {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[PAUSED_AGENTS_KEY] : null;
  return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : []);
}

/**
 * Why no automatic run of this agent may start: it is paused. Null while it
 * runs, and always null while `channels` is off: a pause nobody can see or
 * undo never holds a trigger. Pure.
 */
export function agentPauseReason(metadata: unknown, agentName: string | null | undefined): string | null {
  if (!agentName || !resolveFeatureFlag(metadata, 'channels')) return null;
  return pausedAgents(metadata).has(agentName) ? `agent ${agentName} is paused` : null;
}

/**
 * Pause or resume one agent: add or remove its name in
 * `projects.metadata.paused_agents`, in one SQL statement that touches no other
 * key. Returns the project's metadata after the write, or null when no live
 * project matched.
 */
export async function setAgentPaused(projectId: string, agentName: string, paused: boolean): Promise<unknown | null> {
  const current = sql`coalesce(${projectsView.metadata} -> ${PAUSED_AGENTS_KEY}, '[]'::jsonb)`;
  const next = paused
    ? sql`(select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(${current} || to_jsonb(${agentName}::text)) as x)`
    : sql`(select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(${current}) as x where x <> ${agentName})`;
  const [row] = await updateProjectRowsReturning(eq(projectsView.projectId, projectId), {
    metadata: sql`coalesce(${projectsView.metadata}, '{}'::jsonb) || jsonb_build_object(${PAUSED_AGENTS_KEY}::text, ${next})`,
    updatedAt: new Date(),
  });
  return row && row.status !== 'archived' ? row.metadata : null;
}

/**
 * Stop every running task of a paused agent, for every person: abort the live
 * turn of each `running` session of the agent, the same call the Stop button
 * makes. The turn is stamped "Stopped by" the person who paused. Best effort:
 * a box that is parked or gone is not a failure. Returns how many sessions
 * were asked to stop.
 */
export async function stopAgentRuns(projectId: string, agentName: string, stoppedBy: string): Promise<number> {
  const rows = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.agentName, agentName), eq(projectSessions.status, 'running')));
  await Promise.all(rows.map((row) => abortRuntimeTurn(row.sessionId, { requestedStop: true, stoppedBy })));
  return rows.length;
}

/**
 * `runtime_context` key kortixd reads (`harness/pi/agent-chat.ts`): this session
 * is a thread of a person's chat with an agent, so its reply leads with a short
 * overview and attaches long output as a file. Reserved (`kortix.`): only the
 * platform sets it.
 */
export const AGENT_CHAT_CONTEXT_KEY = 'kortix.agent_chat';

/**
 * Whether a new session is a thread of a person's chat with an agent: `channels`
 * is on, a person starts it (no calling or parent session), and it
 * is filed in a DM whose agent it runs. My Kortix's own chat is not an agent chat.
 */
export async function startsAgentChat(input: {
  projectMetadata: unknown;
  spaceId: string | null;
  agentName: string | null;
  callerSessionId: string | null | undefined;
  parentSessionId: string | null | undefined;
}): Promise<boolean> {
  if (!input.spaceId || !input.agentName || input.callerSessionId || input.parentSessionId) return false;
  if (isMyKortixAgentName(input.agentName)) return false;
  if (!resolveFeatureFlag(input.projectMetadata, 'channels')) return false;
  const [space] = await db
    .select({ kind: projectSpaces.kind, agent: projectSpaces.dmAgentName })
    .from(projectSpaces)
    .where(eq(projectSpaces.spaceId, input.spaceId))
    .limit(1);
  return space?.kind === 'dm' && space.agent === input.agentName;
}
