/**
 * An inline colleague: a child session a box starts with its own instructions
 * (kortixd `agent({ agent: { instructions } })`, `harness/pi/cloud-subagent.ts`).
 * It runs as its caller's own agent, so its grant, connectors, secrets,
 * sandbox and originating channel are the caller's, never another agent's.
 * The instructions ride in runtime_context under
 * {@link AGENT_INSTRUCTIONS_CONTEXT_KEY}; the child's runtime runs on them in
 * place of its agent's prompt.
 *
 * My Kortix may not start another My Kortix session (META_AGENT_RECURSION).
 * A colleague is the exception: it has My Kortix's access and its own prompt,
 * so it is not a second coordinator. Only a box creating its own child sets a
 * `kortix.` key (`session-runtime-context.ts`), so the key also proves that a
 * box made the call.
 */
export const AGENT_INSTRUCTIONS_CONTEXT_KEY = 'kortix.agent.instructions';

/** The create body's runtime_context carries an inline colleague's instructions. Pure. */
export function isInlineColleagueContext(runtimeContext: unknown): boolean {
  if (!runtimeContext || typeof runtimeContext !== 'object' || Array.isArray(runtimeContext)) return false;
  const instructions = (runtimeContext as Record<string, unknown>)[AGENT_INSTRUCTIONS_CONTEXT_KEY];
  return typeof instructions === 'string' && instructions.trim() !== '';
}
