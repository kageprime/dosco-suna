/**
 * The `action_id` the live plan's Stop button reports under.
 *
 * It lives in its own module because `stop.ts` imports `turn.ts` (for
 * `loadTurn` / `finalizeTurn`) and `turn.ts` needs the id to draw the button —
 * a plain constant breaks the cycle without a type-only import dance.
 */
export const SLACK_STOP_ACTION = 'stop_run';

/** The "Switch agent" button under an agent's answer: opens this channel's agent picker for the clicker. */
export const SLACK_SWITCH_AGENT_ACTION = 'answer_switch_agent';
