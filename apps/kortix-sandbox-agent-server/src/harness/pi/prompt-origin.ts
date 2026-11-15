/**
 * Where a turn's prompt came from, read from its text. The runtime prompt body
 * carries no origin field (`POST /kortix/runtime/sessions/:id/prompt`), so pi
 * reads the envelope apps/api wraps around every prompt it did not get from a
 * person:
 *
 * | Origin | Envelope | Writer |
 * | --- | --- | --- |
 * | `peer` | `[message from … · session … · #…]` | `peerMessagePromptText` (`@kortix/shared/peer-message-prompt`) |
 *  * | `trigger` | `<trigger_event>` block, or `[REMINDER <id> — …]` | a trigger-started session; a reminder or runtime trigger fire |
 * | `notice` | `… This message is from the platform, not from the user.` head, or a synthetic prompt with a `<kortix_system type="session-report">` block | apps/api `subagentNoticeText` (`system:subagent-finished`): a background subagent's or a teammate's report |
 * | `human` | anything else | the person, a parent agent's task |
 *
 * Two features read it, as Claude Code does for its `origin`: the word
 * `ultracode` opts a turn into a workflow only in a `human` prompt, and the
 * `workflow` tool refuses to start or resume in a `peer`, `trigger` or
 * `notice` turn. A notice turn is the platform reporting a run's end: a
 * workflow started there would undo what the person decided (a Stop) without
 * them asking. A person who pastes the notice head only refuses their own
 * workflow; nothing else reads `notice` as more trusted than `human`.
 */
import { parsePeerMessagePrompt } from '@kortix/shared/peer-message-prompt'

export type PromptOrigin = 'human' | 'peer' | 'trigger' | 'notice'

/** The head `reminderPromptText` writes (`@kortix/shared/reminder-prompt`). */
const REMINDER_HEAD = /^\[REMINDER (?:reminder|trigger|automation)\.[0-9a-f]{12} — /
/** The tag a trigger-started session's prompt carries (`@kortix/shared/trigger-event`). */
export const TRIGGER_EVENT_TAG = '<trigger_event>'
/** The head apps/api `subagentNoticeText` opens a background subagent's or a teammate's report with. */
const NOTICE_HEAD = /^(?:A background subagent you started has finished|Your teammate [A-Za-z0-9._-]+ finished its turn and is idle)\. This message is from the platform, not from the user\./
/** The report block of the same notice; a batch of notices (`session-notice-batch.ts`) may carry it after another notice. */
const SESSION_REPORT_TAG = '<kortix_system type="session-report"'

/**
 * `synthetic`: every text part of the prompt was harness context (`PromptInput.synthetic`,
 * set only by the API). A notice is synthetic; a person's own prompt never is.
 */
export function promptOrigin(text: string | null | undefined, opts: { synthetic?: boolean } = {}): PromptOrigin {
  const value = text ?? ''
  if (parsePeerMessagePrompt(value)) return 'peer'
  if (REMINDER_HEAD.test(value) || value.includes(TRIGGER_EVENT_TAG)) return 'trigger'
  if (NOTICE_HEAD.test(value) || (opts.synthetic === true && value.includes(SESSION_REPORT_TAG))) return 'notice'
  return 'human'
}

/** `ultracode` as a word, in any case. */
const ULTRACODE = /\bultracode\b/i

/** The person's own prompt names `ultracode`: this turn runs its task as a workflow. */
export function ultracodeRequested(text: string | null | undefined): boolean {
  return promptOrigin(text) === 'human' && ULTRACODE.test(text ?? '')
}

/** The per-turn system line an `ultracode` prompt adds (`turnExtension`). */
export const ULTRACODE_SYSTEM_LINE =
  'The person wrote "ultracode" in this message: plan and run this task as a workflow (the workflow tool), not turn by turn. ' +
  'Write the script for the task, say in one line what will run, then call workflow. Answer a question that needs no work directly. ' +
  'When every unit of the task is answerable in one step (a fact, a sum, a word), answer it yourself here instead and say in one line why no workflow runs.'

/** Why the workflow tool does not start in a turn of this origin. */
export function workflowOriginRefusal(origin: PromptOrigin): string | null {
  if (origin === 'human') return null
  if (origin === 'notice') {
    return "A workflow starts or resumes only from a person's own message, and this turn came from a platform notice (a background subagent's report). Start or resume no workflow here: report the result to the person. When part of the run was stopped or failed, say so, and let the person ask for it again."
  }
  const from = origin === 'peer' ? 'a message from another session' : 'a trigger or reminder'
  return `A workflow starts only from a person's own message, and this turn came from ${from}. Do the work with the agent tool, or tell the person a workflow would help and let them start it.`
}
