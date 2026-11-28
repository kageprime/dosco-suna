// Agent directory — `/v1/workspaces/:id/agent-directory`
// (apps/api/src/projects/routes/agent-directory.ts). An entry is an agent of
// the workspace a person can message (every kortix.yaml agent except
// `mode: subagent` ones, and My Kortix when the workspace runs it). Its chat is
// the caller's DM space with the agent: open it with `getOrCreateWorkspaceDm`.
// The route answers 403 `feature_disabled` while the workspace's `channels`
// flag is off.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** An agent the caller can message. Same fields as the API's `AgentDirectoryEntry`. */
export interface WorkspaceAgentEntry {
  /** The agent name in kortix.yaml. */
  name: string;
  /** The name a person reads: My Kortix for the built-in agent, else the agent name. */
  display_name: string;
  /** The agent's model (`provider/model`), or null for the workspace default. */
  model: string | null;
  /** `active`: it answers. `paused`: messages reach it, but no schedule or event starts it. `off`: kortix.yaml disables it or its block has an error. */
  status: 'active' | 'paused' | 'off';
  /** The workspace's `default_agent`. */
  is_default: boolean;
  /** My Kortix, the built-in agent. */
  builtin: boolean;
  /** The caller's chat with the agent (their DM space), or null before they first open it. */
  chat_space_id: string | null;
}

/**
 * The agents the caller can message, My Kortix first when the workspace runs
 * it, then kortix.yaml order. Rejects with 403 `feature_disabled` while
 * `channels` is off; the caller decides what to show, so the error never
 * reaches the host error handler.
 */
export async function listWorkspaceAgentDirectory(workspaceId: string): Promise<WorkspaceAgentEntry[]> {
  const res = unwrap(await backendApi.get<{ agents: WorkspaceAgentEntry[] }>(`/workspaces/${workspaceId}/agent-directory`, { showErrors: false }));
  return res.agents;
}

/** The agent after a pause or resume, and how many of its running tasks the pause stopped (0 on resume). */
export interface WorkspaceAgentPauseResult {
  agent: WorkspaceAgentEntry;
  stopped_sessions: number;
}

/**
 * Pause or resume an agent. A paused agent still gets messages, but no
 * schedule, webhook, event or monitor starts it; a person firing a trigger by
 * hand still runs it. Pausing also stops every running task of the agent, for
 * every person. Needs the trigger-update permission (else 403).
 */
export async function setWorkspaceAgentPaused(workspaceId: string, name: string, paused: boolean): Promise<WorkspaceAgentPauseResult> {
  return unwrap(
    await backendApi.post<WorkspaceAgentPauseResult>(
      `/workspaces/${workspaceId}/agent-directory/${encodeURIComponent(name)}/pause`,
      { paused },
      { showErrors: false },
    ),
  );
}
