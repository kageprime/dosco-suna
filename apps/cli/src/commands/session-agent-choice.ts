/**
 * A session My Kortix starts names its agent (apps/api session-create.ts):
 * a create that names none is 400 `AGENT_REQUIRED`, and one that names My
 * Kortix is 400 `META_AGENT_RECURSION`. Both bodies list the project agents
 * the caller may name. `sessions new` turns that into the `--agent` fix, and
 * `doctor` retries once with the first agent listed.
 */

export const AGENT_CHOICE_CODES = ['AGENT_REQUIRED', 'META_AGENT_RECURSION'] as const;
export type AgentChoiceCode = (typeof AGENT_CHOICE_CODES)[number];

export interface AgentChoice {
  code: AgentChoiceCode;
  message: string;
  /** The project agents to name. Empty from an older API or a project with none. */
  agents: string[];
}

/** The agent refusal in a failed create, or null for any other failure. */
export function agentChoiceFromError(err: unknown): AgentChoice | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { body?: unknown; details?: unknown; message?: unknown };
  const body = (isRecord(e.body) ? e.body : isRecord(e.details) ? e.details : null) as Record<string, unknown> | null;
  if (!body) return null;
  const code = body.code;
  if (typeof code !== 'string' || !(AGENT_CHOICE_CODES as readonly string[]).includes(code)) return null;
  const agents = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
  const message = typeof body.error === 'string' ? body.error : typeof e.message === 'string' ? e.message : '';
  return { code: code as AgentChoiceCode, message, agents };
}

/** The CLI fix for the refusal: the exact `--agent` flag and the agents to
 *  pass. Null when the API's own message already names `--agent`. */
export function agentChoiceHint(choice: AgentChoice): string | null {
  if (choice.message.includes('--agent')) return null;
  if (choice.agents.length === 0) {
    return 'Pass --agent <name> with a project agent from kortix.yaml (kortix agents ls lists them).';
  }
  return `Pass --agent <one of: ${choice.agents.join(', ')}>, e.g. kortix sessions new --agent ${choice.agents[0]} --prompt "…"`;
}

/** The `--agent` hint for a failed create, or null. */
export function agentChoiceHintFor(err: unknown): string | null {
  const choice = agentChoiceFromError(err);
  return choice ? agentChoiceHint(choice) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
