/**
 * The last answer of a session's turn, read from the stored session log
 * (`GET …/log`'s reader). Postgres only: no sandbox is resolved or woken.
 *
 * Two server readers use it: the sub-agent notice (`subagent-notice.ts`, the
 * child's report for its parent) and peer messages (`peer-messages/service.ts`,
 * the result excerpt and the idle notice's answer).
 *
 * The answer is the turn the window ends on: the messages after the newest
 * user message. Only conversation turns count (`kind: 'turn'`, role user or
 * assistant): a compaction inside a turn does not end it, and a system or
 * context message is not an answer. `text` is the newest assistant message
 * with non-blank text; `error` is the newest assistant message's error.
 */
import type { SessionLogPage } from '@kortix/api-contract/session-log';
import { readSessionLogPage } from '../session-log-read';

/** A `full` answer is cut here; a digest answer is cut at `maxChars`. */
export const FULL_ANSWER_CHARS = 16_000;

/** A message as `GET …/log` serves it. */
type LogMessage = SessionLogPage['messages'][number];

export interface LastTurnAnswer {
  /** The message that carried `text`; null when no assistant message had text. */
  id: string | null;
  /** `''` when the turn wrote no text. */
  text: string;
  /** The turn's error (`name` = the log's error `code`); never the reader's own failure. */
  error: { name?: string; message?: string } | null;
}

export interface LastAnswerOptions {
  /** Messages read from the end of the root thread. */
  limit: number;
  /** A digest answer is whitespace-normalized and cut at this many characters. */
  maxChars: number;
  /** Keep line breaks and cut at `FULL_ANSWER_CHARS` instead (a report a model reads). */
  full?: boolean;
}

/** The answer of the turn `messages` (ascending by seq) end on; null when the turn has no assistant message. */
export function lastTurnAnswerOf(messages: LogMessage[], options: Omit<LastAnswerOptions, 'limit'>): LastTurnAnswer | null {
  const turn = messages.filter((m) => m.kind === 'turn' && (m.role === 'user' || m.role === 'assistant'));
  const lastUser = turn.map((m) => m.role).lastIndexOf('user');
  const assistants = turn.slice(lastUser + 1);
  const last = assistants.at(-1);
  if (!last) return null;
  const answers = assistants.map((m) => ({ id: m.message_id, text: answerText(m, options) }));
  const withText = [...answers].reverse().find((a) => a.text);
  return {
    id: withText?.id ?? null,
    text: withText?.text ?? '',
    error: last.error ? { name: last.error.code, message: last.error.message } : null,
  };
}

/** The answer of the session's newest turn, from its stored log; null when nothing is saved or the turn has no answer. */
export async function readLastTurnAnswer(sessionId: string, options: LastAnswerOptions): Promise<LastTurnAnswer | null> {
  const page = await readSessionLogPage({ sessionId, threadId: null, beforeSeq: null, limit: options.limit });
  if (!page || page === 'unknown_thread') return null;
  return lastTurnAnswerOf(page.messages, options);
}

/** A message's visible text: its non-synthetic text blocks, one per line. A stored preview (F3) says it was cut. */
function answerText(message: LogMessage, options: Omit<LastAnswerOptions, 'limit'>): string {
  const blocks = message.blocks.filter(
    (b): b is Extract<LogMessage['blocks'][number], { type: 'text' }> => b.type === 'text' && !b.synthetic && !!b.text,
  );
  const text = blocks.map((b) => b.text).join('\n').trim();
  if (!text) return '';
  const stored = blocks.find((b) => b.ref);
  if (options.full) {
    if (stored) return `${text.slice(0, FULL_ANSWER_CHARS)}…[truncated: a stored text of ${stored.bytes ?? 'unknown'} bytes]`;
    return text.length <= FULL_ANSWER_CHARS ? text : `${text.slice(0, FULL_ANSWER_CHARS)}…[truncated: ${FULL_ANSWER_CHARS} of ${text.length} chars]`;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= options.maxChars ? flat : `${flat.slice(0, Math.max(0, options.maxChars - 1))}…`;
}
