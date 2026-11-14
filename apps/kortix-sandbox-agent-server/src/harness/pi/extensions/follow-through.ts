/**
 * Follow-through: a top-level session never ends a turn with a wait it does
 * not own. A run that settled with an open wait goes back to the model once,
 * with a hidden note, before the person gets control back.
 *
 * A wait is open when any is true:
 *
 * - the reply offers a later check instead of setting one ("Want me to check
 *   the thread in a couple of hours?");
 * - the reply promises a later check that nothing will run ("⏳ I'll check in
 *   tomorrow morning", with no loop set: real runs on 2026-11-11 did this);
 * - the run acted on the outside world through a connector (sent or replied
 *   to an email, created a transfer, posted a message) and set no wake-up.
 *
 * A promise or an outward action is fine when the session has an active loop
 * or wake-up (`GET …/sessions/:id/reminders`); an offer never is. The check
 * reads what the run did, not the language it wrote in, except for the offer
 * and the promise, which it matches in English and German.
 *
 * pi's `agent_before_settle` with `continue: true` runs one more model
 * request (docs/extensions.md "Guard continuation conditions"). The note goes
 * out at most once per run, so the guard can never loop. Registered by
 * runtime.ts `followThroughExtension` for a top-level session with Loops on.
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'

export const FOLLOW_THROUGH_NOTE_TYPE = 'kortix-follow-through'
/** The project flag behind session loops and wake-ups (`reminders`, named Loops). */
export const LOOPS_FLAG = 'reminders'

/** Why the run must not settle yet. */
export type OpenWait = { kind: 'offer'; offer: string } | { kind: 'promise'; promise: string } | { kind: 'acted'; actions: string[] }

/** The parts of a pi message the check reads. */
type Block = { type: string; id?: string; text?: string; name?: string; arguments?: Record<string, unknown> }
type Message = { role: string; content?: string | Block[]; toolCallId?: string; isError?: boolean }

const ASK = String.raw`(?:want me to|do you want me to|should I|shall I|would you like me to|I can|I could|happy to|soll ich|willst du(?:, dass ich)?|möchtest du(?:, dass ich)?|sollen wir)`
const LATER = String.raw`(?:check|watch|follow[ -]?up|remind|chase|ping|look again|keep an eye|monitor|nudge|circle back|let you know when|tell you when|get back to you|check back|report back|nachschauen|nachsehen|prüfen|nachhaken|erinnern|im Auge|Bescheid|melde mich)`
/** "Want me to check the thread for her answer in a couple of hours?": one sentence, ending in a question mark. */
const OFFER = new RegExp(String.raw`[^.!?\n]{0,200}\b${ASK}\b[^.!?\n]{0,160}\b${LATER}[^.!?\n]{0,160}\?`, 'i')
const WILL = String.raw`(?:I['’]ll|I will|I['’]m going to|ich)`
const WHEN = String.raw`(?:tomorrow|tonight|morning|afternoon|evening|later|daily|hourly|every|in (?:a|an|\d+|a few|a couple)|at \d|after|until|once|by (?:mon|tue|wed|thu|fri|sat|sun|\d)|on (?:mon|tue|wed|thu|fri|sat|sun)|if (?:she|he|they|it|nothing)|morgen|später|täglich|in \d+|um \d|bis|sobald|falls)`
/** "⏳ I'll check in tomorrow morning", "if she's still quiet after 2 days, I'll draft a chase": a check the reply says will happen. */
const PROMISE = new RegExp(String.raw`(?:^|\n)\s{0,10}⏳[^\n]{0,300}|[^.!?\n]{0,200}\b${WILL}\b[^.!?\n]{0,160}\b${LATER}[^.!?\n]{0,200}|[^.!?\n]{0,200}\b${WHEN}\b[^.!?\n]{0,160}\b${WILL}\b[^.!?\n]{0,160}\b${LATER}[^.!?\n]{0,200}`, 'i')
/**
 * The reply text the guard reads: its end. An offer or a promise closes a reply, and the patterns
 * run in the daemon's one thread, so their input and every quantifier are bounded: a long reply on
 * one line took seconds to match before (a 20,000-character line froze the box for 110 s).
 */
const REPLY_TAIL_CHARS = 4000
const HAS_WHEN = new RegExp(String.raw`\b${WHEN}\b|⏳`, 'i')

/** A connector call the CLI runs: `kortix connectors call <slug> <action> …`. */
const CONNECTOR_CALL = /\bkortix\s+connectors\s+call\s+([\w.-]+)\s+([\w.-]+)/g
/** An action that hands something to someone else, whose answer comes later. */
const OUTWARD = /(?:^|[_.-])(?:send|reply|forward|draft|post|message|mail|invite|transfer|pay|payment|fund|order|book|submit|request|quote|invoice)/i
/** A read, by its leading verb after an optional toolkit prefix: `GMAIL_LIST_DRAFTS`, `get_invoice`. Its noun can be an outward word, but nothing was handed to anyone. */
const READ = /^(?:[a-z0-9]+[_.-])?(?:get|list|fetch|search|find|read|count)(?:[_.-]|$)/i
/** The tools and commands that set a wake-up. */
const WAKE_ACTIONS = new Set(['follow_up', 'wake_on', 'create', 'automate'])
/** The tools whose work reports back by itself: a promise to report it needs no wake-up. */
const DELEGATING = new Set(['agent', 'task', 'workflow', 'send_message'])
const WAKE_COMMAND = /\bkortix\s+(?:loops?\s+(?!ls\b|list\b|rm\b|delete\b|pause\b)|triggers\s+add\b|goals\s+new\b)/

function blocks(message: Message): Block[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return Array.isArray(message.content) ? message.content : []
}

/** The messages of the current run: everything after the last user message. */
export function runMessages(messages: readonly Message[]): Message[] {
  let start = messages.length
  while (start > 0 && messages[start - 1]!.role !== 'user') start--
  return messages.slice(start)
}

/** The text a tool call ran: a shell command, or its arguments. */
function callText(block: Block): string {
  const args = block.arguments ?? {}
  return typeof args.command === 'string' ? args.command : JSON.stringify(args)
}

/** The tool calls of the run whose result is an error: such a call set or recorded nothing. */
export function failedCalls(run: readonly Message[]): Set<string | undefined> {
  return new Set(run.filter((message) => message.role === 'toolResult' && message.isError).map((message) => message.toolCallId))
}

/** The run set a wake-up itself (the API is asked only when it did not). A call whose result is an error set nothing. */
export function setWakeUp(run: readonly Message[]): boolean {
  const failed = failedCalls(run)
  return run.some((message) =>
    blocks(message).some((block) => {
      if (block.type !== 'toolCall' || (block.id && failed.has(block.id))) return false
      if (block.name === 'kortix_schedules') return WAKE_ACTIONS.has(String(block.arguments?.action ?? ''))
      return WAKE_COMMAND.test(callText(block))
    }),
  )
}

/** The run handed work to a colleague, a workflow or another session. */
function delegated(run: readonly Message[]): boolean {
  return run.some((message) => blocks(message).some((block) => block.type === 'toolCall' && DELEGATING.has(block.name ?? '')))
}

/** `gmail.reply_to_thread`: each outward connector call of the run, in order, once. */
export function outwardActions(run: readonly Message[]): string[] {
  const found = new Set<string>()
  for (const message of run) {
    for (const block of blocks(message)) {
      if (block.type !== 'toolCall') continue
      for (const [, slug, action] of callText(block).matchAll(CONNECTOR_CALL)) if (!READ.test(action!) && OUTWARD.test(action!)) found.add(`${slug}.${action}`)
    }
  }
  return [...found]
}

/** The run's last reply text. */
function finalText(run: readonly Message[]): string {
  for (let index = run.length - 1; index >= 0; index--) {
    const message = run[index]!
    if (message.role !== 'assistant') continue
    const text = blocks(message)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** The wait this run leaves open, or null. `hasWakeUp` is asked only when the run looks open. */
export async function openWait(messages: readonly Message[], hasWakeUp: () => Promise<boolean>): Promise<OpenWait | null> {
  const run = runMessages(messages)
  if (setWakeUp(run)) return null
  const text = finalText(run).slice(-REPLY_TAIL_CHARS)
  const offer = text.match(OFFER)?.[0]?.trim()
  const promise = text.match(PROMISE)?.[0]?.trim()
  const actions = outwardActions(run)
  const wait: OpenWait | null = offer
    ? { kind: 'offer', offer }
    : promise && HAS_WHEN.test(promise) && !delegated(run)
      ? { kind: 'promise', promise }
      : actions.length
        ? { kind: 'acted', actions }
        : null
  if (!wait) return null
  // An offer still breaks the rule with a loop set: the person must not be asked for what is already running.
  if (wait.kind !== 'offer' && (await hasWakeUp())) return null
  return wait
}

/** The hidden note the model reads before it may end the turn. */
export function followThroughNote(wait: OpenWait): string {
  const why =
    wait.kind === 'offer'
      ? `Your reply offers a later check instead of setting it: "${wait.offer}"`
      : wait.kind === 'promise'
        ? `Your reply promises a later check, and no loop or wake-up is set to run it: "${wait.promise}"`
        : `This turn acted on the outside world (${wait.actions.join(', ')}) and no loop or wake-up is set for what comes back.`
  return [
    `[follow-through] ${why}`,
    'Never ask the person whether to follow up. Own the wait: set it now with `kortix_schedules` (`wake_on` when an event can wake you, else `follow_up`), with a `text` for the turn that wakes up: what is pending, what to check, what to do for each outcome, when to stop.',
    'Then tell the person in one line what you set: "⏳ I\'ll check the thread for her reply at 21:30 and tell you." Do not repeat the rest of your reply.',
    'Set nothing and reply with nothing when nothing really comes back: the work is complete and verified, or a running hand-off, workflow or team reports back by itself.',
  ].join('\n')
}

/** The hidden notes the runtime adds before a run may settle: this one and goal mode's (`goal-mode.ts`). */
const HIDDEN_NOTE_TYPES = new Set([FOLLOW_THROUGH_NOTE_TYPE, 'kortix-goal'])

/** A session entry that is a hidden settle note: the session log writes no message for it. */
export function isHiddenNote(entry: { type?: string; customType?: string }): boolean {
  return entry.type === 'custom_message' && HIDDEN_NOTE_TYPES.has(entry.customType ?? '')
}

export interface FollowThroughOptions {
  /** True when the session has an active loop or wake-up. A failed read counts as true: never nudge on a guess. */
  hasWakeUp: () => Promise<boolean>
  /** False for a turn the guard leaves alone (a peer message, a trigger-started session). */
  applies: () => boolean
  /** Called with each note sent, for the log. */
  onNudge?: (wait: OpenWait) => void
}

export function followThrough(options: FollowThroughOptions): InlineExtension {
  return {
    name: FOLLOW_THROUGH_NOTE_TYPE,
    hidden: true,
    factory: (pi) => {
      let nudged = false
      pi.on('agent_settled', () => {
        nudged = false
      })
      pi.on('agent_before_settle', async (event) => {
        // Not `context.canContinue`: it is false after a final reply, and the note is what the next request continues from.
        if (nudged || event.outcome !== 'completed' || !options.applies()) return undefined
        const wait = await openWait(event.context.contextMessages as Message[], options.hasWakeUp)
        if (!wait) return undefined
        nudged = true
        options.onNudge?.(wait)
        // The model reads the note; the session log leaves it out (`isHiddenNote`), so the person never sees it.
        // pi replaces the entries with each hook's result: keep what an earlier hook (goal mode) added.
        return { entries: [...event.entries, { type: 'custom_message' as const, customType: FOLLOW_THROUGH_NOTE_TYPE, content: followThroughNote(wait), display: false }], continue: true }
      })
    },
  }
}
