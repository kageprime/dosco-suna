/**
 * Goal mode: a chat that owns a goal (`kortix goals new --here`) stays on it.
 * The Goals API holds the goal and decides done (an independent verifier
 * session); this extension keeps the chat working it, deterministically:
 *
 * - every turn, the goal and its criteria lead the system prompt;
 * - a run may not settle while the goal is `active` and the run recorded
 *   nothing on it (`kortix goals progress | verify | transition`): it goes
 *   back to the model with a hidden note, at most `MAX_NUDGES` times, and
 *   stops early when a nudged step used no tool (it is stuck, not working);
 * - while the goal waits on the outside world, the goal's heartbeat loop
 *   (the API's, every 4 h by default) wakes the chat; `waiting_on_user`,
 *   `verifying`, a pause or a stop let the run settle;
 * - the person ends it by telling the chat (`kortix goals stop`: goal mode
 *   has no Goals page). That command runs only in a turn the person started:
 *   in a wake, a loop fire or a peer message it is blocked, so the chat
 *   cannot drop its goal while nobody watches.
 *
 * The chat reads its goal once per box (`undefined` → read); after that only
 * while it has one, or after a run that ran `kortix goals`. A chat without a
 * goal costs one API call per box. Registered by runtime.ts
 * `goalModeExtensions` for a top-level session whose box lists `goal_mode`.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { promptOrigin } from '../prompt-origin'
import { failedCalls, runMessages } from './follow-through'

export const GOAL_MODE_BOX_FLAG = 'goal_mode'
/** Must stay in follow-through.ts `HIDDEN_NOTE_TYPES`: the session log hides these notes. */
export const GOAL_NOTE_TYPE = 'kortix-goal'
/** Nudges per run: each one is a model request. Claude Code's Stop-hook cap is 8; Codex blocks after 3 empty turns. */
export const MAX_NUDGES = 3

/** The fields of a goal (`GET /workspaces/:id/goals`) this extension reads. */
export interface ChatGoal {
  goal_id: string
  title: string
  state: string
  slug: string
  folder: string
  owner_session_id: string | null
  paused_at: string | null
  waiting_on: string | null
  next_wake_at: string | null
  criteria: { id: string; text: string; reported_met?: boolean; verified?: boolean }[]
}

type Block = { type: string; id?: string; text?: string; name?: string; arguments?: Record<string, unknown> }
type Message = { role: string; content?: string | Block[]; toolCallId?: string; isError?: boolean }

const OPEN = new Set(['draft', 'active', 'waiting_on_user', 'verifying'])
/** A command that records where the goal stands. Creating the goal is not one: the turn that creates it starts the work. */
const RECORDS = /\bkortix\s+goals\s+(?:progress|verify|transition)\b/
const GOALS_COMMAND = /\bkortix\s+goals\b/
const STOP_COMMAND = /\bkortix\s+goals\s+stop\b/
/** How every prompt the goal engine writes starts (apps/api goals/rules.ts `goalWakePrompt`). */
const GOAL_WAKE = /^Goal wake: /

/** The person started this turn with a message of their own: not a loop fire, a goal wake or a peer message. */
export function personTurn(text: string | null | undefined): boolean {
  return promptOrigin(text) === 'human' && !GOAL_WAKE.test(text ?? '')
}

/** Why a tool call that stops the goal does not run in this turn, or null. */
export function stopRefusal(input: unknown, inPersonTurn: boolean): string | null {
  if (inPersonTurn) return null
  const command = typeof (input as { command?: unknown } | null)?.command === 'string' ? (input as { command: string }).command : JSON.stringify(input ?? '')
  if (!STOP_COMMAND.test(command)) return null
  return 'Only the person stops this goal, in a message of their own, and this turn came from a wake, a loop or another session. Do the next step, or ask them: `kortix goals transition waiting_on_user --reason "<question>"`.'
}

function blocks(message: Message): Block[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return Array.isArray(message.content) ? message.content : []
}

function toolCalls(run: readonly Message[]): Block[] {
  return run.flatMap((message) => blocks(message).filter((block) => block.type === 'toolCall'))
}

function commandOf(block: Block): string {
  const args = block.arguments ?? {}
  return typeof args.command === 'string' ? args.command : JSON.stringify(args)
}

/** This chat's open goal among the goals it can read, or null. */
export function ownGoal(goals: readonly ChatGoal[], sessionId: string): ChatGoal | null {
  return goals.find((goal) => goal.owner_session_id === sessionId && OPEN.has(goal.state)) ?? null
}

/** The run recorded where the goal stands. A recording command whose result is an error recorded nothing. */
export function recorded(run: readonly Message[]): boolean {
  const failed = failedCalls(run)
  return toolCalls(run).some((block) => !(block.id && failed.has(block.id)) && RECORDS.test(commandOf(block)))
}

/** The run ran any `kortix goals` command: the goal may have changed. */
export function touchedGoals(run: readonly Message[]): boolean {
  return toolCalls(run).some((block) => GOALS_COMMAND.test(commandOf(block)))
}

function criteriaLines(goal: ChatGoal): string {
  return goal.criteria.map((c) => `- ${c.id}: ${c.text} (${c.verified ? 'verified' : c.reported_met ? 'reported met' : 'open'})`).join('\n')
}

/** The system-prompt section of a chat with an open goal. */
export function goalSection(goal: ChatGoal): string {
  const state = goal.paused_at ? 'paused by a person' : goal.state
  return [
    '## Goal mode',
    `This chat owns goal "${goal.title}" (${state}). It ends only when the independent verifier passes every criterion, or a person stops it. Never shrink it to something easier.`,
    criteriaLines(goal),
    `Its folder in Files is ${goal.folder}: evidence files go in ${goal.folder}/evidence/ (\`kortix drive put <file> ${goal.folder}/evidence/<name>.md\`).`,
    'Each turn: do the next step that moves it forward, then record where it stands before you end the turn:',
    '- `kortix goals progress --summary "<what changed, what is next>"` (with `--met <id> --evidence <id>=evidence/<name>.md` for a criterion you proved);',
    '- `kortix goals verify` when every criterion is met with evidence: a separate verifier decides;',
    '- `kortix goals transition waiting_on_user --reason "<question>"` when only the person can unblock it;',
    '- `kortix goals transition active --reason "<their answer>"` when they answered that question here: the goal works again.',
    `Waiting on someone else (a reply, an approval, a payment): record it with \`progress\`, set a \`wake_on\` when an event can wake you, and end the turn. The goal's heartbeat wakes this chat${goal.next_wake_at ? ` (next ${goal.next_wake_at})` : ''}.`,
    'The person tells you to stop or drop it: `kortix goals stop --reason "<what they said>"`, then say it is stopped. Only then. Never stop it yourself because it is hard, slow or blocked.',
  ].join('\n')
}

/** The hidden note of a run that would settle on an active goal without recording anything. */
export function goalNote(goal: ChatGoal): string {
  return [
    `[goal] Goal "${goal.title}" is active and this turn recorded nothing on it.`,
    'Do the next step now, or record why you stop: `kortix goals progress --summary "…"`, `kortix goals verify`, or `kortix goals transition waiting_on_user --reason "…"`.',
    'Then end with one line for the person. Do not repeat earlier text.',
  ].join('\n')
}

export type GoalSettle = { continue: false } | { continue: true; note: string }

/**
 * What a settling run does. `nudges` counts this run's notes so far;
 * `sinceNudge` is the messages after the last note (empty before the first).
 */
export function goalSettle(goal: ChatGoal | null, run: readonly Message[], nudges: number, sinceNudge: readonly Message[]): GoalSettle {
  if (!goal || goal.state !== 'active' || goal.paused_at) return { continue: false }
  if (recorded(run)) return { continue: false }
  if (nudges >= MAX_NUDGES) return { continue: false }
  // A nudged step that used no tool is stuck: more notes only burn requests.
  if (nudges > 0 && toolCalls(sinceNudge).length === 0) return { continue: false }
  return { continue: true, note: goalNote(goal) }
}

export interface GoalModeOptions {
  sessionId: string
  /** The goals this session can read (`GET /workspaces/:id/goals`), or null when the read failed. */
  listGoals: () => Promise<ChatGoal[] | null>
  /** False for a turn the extension leaves alone (a peer message). */
  applies: () => boolean
  /** The text of the prompt that started the current turn. */
  turnText: () => string
  onNudge?: (goal: ChatGoal, nudges: number) => void
}

export function goalMode(options: GoalModeOptions): InlineExtension {
  return {
    name: GOAL_NOTE_TYPE,
    hidden: true,
    factory: (pi) => {
      // undefined: not read yet. null: this chat has no open goal.
      let goal: ChatGoal | null | undefined
      let nudges = 0
      let nudgedAt = 0
      const refresh = async () => {
        const goals = await options.listGoals().catch(() => null)
        // A failed read keeps what the chat knew: never drop a goal on a network error.
        if (goals) goal = ownGoal(goals, options.sessionId)
        return goal ?? null
      }
      pi.on('before_agent_start', async (event) => {
        const current = goal === undefined || goal ? await refresh() : null
        return current ? { systemPrompt: `${event.systemPrompt}\n\n${goalSection(current)}` } : undefined
      })
      pi.on('tool_call', (event) => {
        const reason = stopRefusal(event.input, personTurn(options.turnText()))
        return reason ? { block: true, reason } : undefined
      })
      pi.on('agent_settled', () => {
        nudges = 0
        nudgedAt = 0
      })
      pi.on('agent_before_settle', async (event) => {
        if (event.outcome !== 'completed' || !options.applies()) return undefined
        const messages = event.context.contextMessages as Message[]
        const run = runMessages(messages)
        if (goal === undefined || goal || touchedGoals(run)) await refresh()
        const decision = goalSettle(goal ?? null, run, nudges, nudges ? messages.slice(nudgedAt) : [])
        if (!decision.continue) return undefined
        nudges += 1
        nudgedAt = messages.length
        options.onNudge?.(goal!, nudges)
        // pi replaces the entries with each hook's result: keep what an earlier hook added.
        return { entries: [...event.entries, { type: 'custom_message' as const, customType: GOAL_NOTE_TYPE, content: decision.note, display: false }], continue: true }
      })
    },
  }
}
