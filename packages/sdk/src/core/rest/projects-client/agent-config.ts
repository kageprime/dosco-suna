import { backendApi } from '../../http/api-client';
import type { AgentCapabilityGrant } from './agent-capabilities';
import { canonicalizeRequiredConnectors } from './agent-connectors';
import { unwrap } from './shared';

// ── Full agent-config editor (the "agent builder", agent-first spec §2.2,
// redirected 2026-07-05 — "one home per concern") ──
// Round-trips the agent's TWO homes as one wire shape: `block` (governance —
// connectors/secrets/skills/kortix_permissions/enabled, written to
// kortix.yaml) and `block.behavior` (the agent's BEHAVIOR — mode/model/
// temperature/top_p/steps/variant/color/hidden/permission/prompt, written to
// the agent's own `.md` (`block.file`, e.g. `agents/<name>.md`) frontmatter +
// body). The backend route is what merges the two files into this one
// response/request shape — see apps/api/src/projects/routes/agent-config.ts.
// Distinct from setAgentScope (agent-scope.ts), which writes only the
// secrets/connectors grant subset. Manager-gated server-side
// (project.agent.write). `editable` on the GET is the server's verdict; the UI
// shows a read-only page when it is false. A block also carries the per-agent
// grants of the project registries (`subagents`, `commands`, `extensions`).

/** A Kortix governance grant on the wire: an allowlist, or the sentinels. */
export type AgentGrantSetV2 = 'all' | 'none' | string[];

/** A single permission action. */
export type PermissionAction = 'ask' | 'allow' | 'deny';

/** A permission rule: a bare action, or a glob-pattern → action map. */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

/** The `permission` tree — a bare action, or a per-capability object. */
export type PermissionConfig = PermissionAction | Record<string, PermissionRule | PermissionAction>;

/** The agent's BEHAVIOR half — everything that lives in the agent's own
 *  `.md` frontmatter (+ `prompt`, the file's BODY text, not a path). */
export interface RuntimeAgentConfig {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  /** The agent's system prompt — the `.md`'s BODY text (frontmatter stripped),
   *  not a file path/reference. */
  prompt?: string;
  hidden?: boolean;
  options?: Record<string, unknown>;
  color?: string;
  steps?: number;
  permission?: PermissionConfig;
}

/** The full agent block on the wire — mirrors `AgentBlockV3` in
 *  @kortix/manifest-schema PLUS the merged `behavior` half (a wire-only
 *  convenience; kortix.yaml itself never nests it — see the module doc
 *  above). */
/** One repository a session clones into its workspace when it starts. */
export interface AgentWorkspaceRepo {
  /** `/workspace` or a folder under it. Default `/workspace`. */
  path?: string;
  /** Monorepo subset: the folders a cone sparse-checkout keeps. */
  sparse?: string[];
}

/** `agents.<name>.workspace` in kortix.yaml. Nothing is cloned and nothing runs unless it says so. */
export interface AgentWorkspaceConfig {
  /** A `sandbox.templates` slug: the machine. Same as `AgentConfigBlock.sandbox`. */
  sandbox?: string;
  /** Explicit clones, on the session branch. Needs `workspace.gitops.read`. */
  repos?: AgentWorkspaceRepo[];
  /**
   * Steps run in order after the clones, each in its own shell, in the first clone's folder.
   * A string is a command; `{ run, cwd }` runs in `cwd` (relative, or under `/workspace`).
   */
  setup?: Array<string | { run: string; cwd?: string }>;
}

export interface AgentConfigBlock {
  /** Repo-relative path of the agent's `.md` (e.g. `agents/support.md`). The
   *  server owns it: it records the path it read or wrote. Send back the value
   *  a read returned; a different value is refused. */
  file?: string;
  enabled?: boolean;
  sandbox?: string;
  /** The space the agent works in (a `spaces:` key, or a bare slug).
   *  Grouping only. Empty string clears it. */
  space?: string;
  connectors?: AgentGrantSetV2;
  /** Connectors that must resolve before the session starts. */
  connectors_required?: string[];
  /** @deprecated Input alias for `connectors_required`. Responses use only
   *  `connectors_required`. */
  connectors_personal?: string[];
  /** Connector slug → policy set name (`connectors[].policy_sets`). A slug
   *  without an entry uses the connector's base rules. Omitted on a write keeps
   *  the declared value; a change needs `project.connector.write`. */
  policy_sets?: Record<string, string>;
  secrets?: AgentGrantSetV2;
  /** The skills this agent may load. v3 also takes `{ exclude: [...] }`: every skill but those. */
  skills?: AgentCapabilityGrant;
  /** v3: the tools this agent may call. Omitted: all. `{ exclude: [...] }`: every tool but those. */
  tools?: AgentCapabilityGrant;
  /** v3: pi's codemode tool. Omitted: `on`. */
  codemode?: 'on' | 'only' | 'off';
  /** v3: what a full context does. `record` (omitted): the agent continues in a fresh context and
   *  searches the session's full record. `summary`: pi's own compaction writes a summary. */
  context?: 'record' | 'summary';
  /** v3: the declared subagents this agent may start (`mode` `subagent` or `all`). */
  subagents?: AgentGrantSetV2;
  /** v3: the registered commands this agent may run. */
  commands?: AgentGrantSetV2;
  /** v3: the registered extensions a session of this agent loads. `{ exclude: [...] }`: every one but those. */
  extensions?: AgentCapabilityGrant;
  /** Kortix Apps (by App slug) this agent may open when the App is
   *  `restricted` or `private`. Deny by default. A `project`-mode App needs
   *  only `project.app.read` in `kortix_permissions`. */
  apps?: AgentGrantSetV2;
  /** Kortix permissions: the `project.*` actions this agent may exercise. */
  kortix_permissions?: AgentGrantSetV2;
  /** @deprecated Renamed to `kortix_permissions`. Servers accept it as an input
   *  alias and answer with `kortix_permissions`. Removed in the next major. */
  kortix_cli?: AgentGrantSetV2;
  /**
   * @deprecated Ignored since 2026-11-08: a session never checks out the project
   * repository at boot, so there is nothing to grant. The SDK neither sends nor
   * returns it. An agent that needs the files runs `kortix workspaces clone`.
   */
  repository_access?: boolean;
  /**
   * What this agent's sessions get to work in: the machine (`sandbox`), explicit clones of
   * the workspace repository (`repos`) and `setup` commands. Both run in the background
   * after the session starts. The string forms are deprecated and ignored.
   */
  workspace?: AgentWorkspaceConfig | 'runtime' | 'read' | 'branch';
  /** The agent's behavior half: its `.md` frontmatter, plus the body as `prompt`. */
  behavior?: RuntimeAgentConfig;
  /**
   * @deprecated The pre-W4 name of `behavior`. An older API answers both with
   * one value; the current API reads and answers only `behavior`. Send the
   * behavior once, as `behavior`. Removed in the next major.
   */
  opencode?: RuntimeAgentConfig;
}

export interface AgentConfigResponse {
  agent: string;
  /** @deprecated The manifest has no version: one schema. Do not branch on it. Removed in the next major. */
  schema_version: number;
  /** True iff the full block is editable. The server decides. */
  editable: boolean;
  /** The manifest's top-level `default_agent`, or null when it names none. */
  default_agent: string | null;
  /** The declared block, or null for an agent not declared yet. */
  block: AgentConfigBlock | null;
  /** The harness a new session of this project runs (`pi`; an older API can answer `opencode`). Absent from an older API. */
  harness?: string;
  /** The `behavior` settings that harness ignores (pi: `options`, `color`). Absent from an older API. */
  ignored_settings?: string[];
  /** Set for a built-in agent (`my_kortix` for `mykortix`): platform-owned, never
   *  editable, `block` is null. Absent for a declared agent and from an older API. */
  builtin?: 'my_kortix';
}

/**
 * The caller draws every failure of this read (the agent page's not-found and
 * error states), so it does not also reach the host's global `onError` toast.
 */
export async function getAgentConfig(projectId: string, agentName: string) {
  const response = unwrap(
    await backendApi.get<AgentConfigResponse>(
      `/workspaces/${projectId}/agents/${encodeURIComponent(agentName)}/config`,
      { showErrors: false },
    ),
  );
  return {
    ...response,
    block: response.block ? canonicalizeAgentBlock(response.block) : null,
  };
}

export async function updateAgentConfig(
  projectId: string,
  agentName: string,
  block: AgentConfigBlock,
) {
  const canonicalBlock = canonicalizeAgentBlock(block, true);
  const response = unwrap(
    await backendApi.put<{
      ok: boolean;
      agent: string;
      schema_version: number;
      block: AgentConfigBlock | null;
    }>(`/workspaces/${projectId}/agents/${encodeURIComponent(agentName)}/config`, canonicalBlock),
  );
  return {
    ...response,
    block: response.block ? canonicalizeAgentBlock(response.block) : null,
  };
}

function canonicalizeAgentBlock(block: AgentConfigBlock, _writing = false): AgentConfigBlock {
  // `repository_access` and the legacy `workspace` shapes are obsolete: a session never
  // checks out the project repository at boot. An older API may still answer them, and an
  // older caller may still send them; neither reaches the other side. The current
  // `workspace` map travels both ways.
  const { repository_access: _access, workspace, ...next } = canonicalizeRequiredConnectors(block);
  const kept: AgentConfigBlock = next;
  if (typeof workspace === 'object' && workspace !== null && !('project_repository' in workspace)) kept.workspace = workspace;
  return kept;
}

export interface GrantSecretToAgentResponse {
  identifier: string;
  agent: string;
  /** True when the agent's list already admitted the identifier, so no commit ran. */
  already_granted: boolean;
  /** True when this edit wrote the manifest's FIRST `agents:` block. From then
   *  on an agent that is not listed receives no project secrets. */
  adopted_governance: boolean;
}

/**
 * Grant one project secret to one agent: merge the IDENTIFIER into that agent's
 * `secrets:` list in kortix.yaml, upserting the agent entry when the manifest
 * does not declare it yet.
 *
 * Broker and network-boundary delivery reach a session only through such an
 * explicit list — `secrets: all` withholds both — so this is the one-click fix
 * for the `no_agent_grant` verdict `ProjectSecret.delivery_blocked_reason`
 * reports. Distinct from `setAgentScope` (agent-scope.ts), which REPLACES an
 * already-declared agent's grant set.
 */
export async function grantSecretToAgent(
  projectId: string,
  identifier: string,
  agentName: string,
) {
  return unwrap(
    await backendApi.post<GrantSecretToAgentResponse>(
      `/workspaces/${projectId}/secrets/${encodeURIComponent(identifier)}/grant`,
      { agent: agentName },
    ),
  );
}

/** @deprecated Use `UpdateWorkspaceDefaultAgentResponse`. Kept permanently. */
export interface UpdateProjectDefaultAgentResponse {
  ok: boolean;
  default_agent: string;
}

/** The workspace name of {@link UpdateProjectDefaultAgentResponse}: the same type. */
export type UpdateWorkspaceDefaultAgentResponse = UpdateProjectDefaultAgentResponse;

/** Set the declared project default in `kortix.yaml` (v2 and v3 projects). */
export async function updateWorkspaceDefaultAgent(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.put<UpdateProjectDefaultAgentResponse>(
      `/workspaces/${projectId}/default-agent`,
      { agent: agentName },
    ),
  );
}

/** @deprecated Use `updateWorkspaceDefaultAgent`. Kept permanently. */
export const updateProjectDefaultAgent = updateWorkspaceDefaultAgent;
