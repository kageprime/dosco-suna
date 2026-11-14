/**
 * The tools that start work running beside the turn (an agent, a workflow). Internal: the
 * settled-turn fold (`work-split.ts`) keeps them in view, and the agent-run fold
 * (`session-log/turns/agent-runs.ts`) folds them once the work they started is done.
 */
export const STARTED_WORK_TOOLS: ReadonlySet<string> = new Set(['agent', 'task', 'agent_spawn', 'workflow']);
