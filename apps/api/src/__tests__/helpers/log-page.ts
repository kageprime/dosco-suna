/**
 * A synthetic `GET …/log` page (`SessionLogPage`) of plain turns, for suites
 * that stub `readSessionLogPage` instead of journaling a log.
 */
import type { SessionLogPage } from '@kortix/api-contract/session-log';

export interface LogTurnMessage {
  role: 'user' | 'assistant';
  text: string;
  /** The v1-style error the old digest carried: `name` becomes the log's `code`. */
  error?: { name?: string; message?: string } | null;
}

export function logPageOf(messages: LogTurnMessage[], threadId = 'thread-root'): SessionLogPage {
  const at = Date.UTC(2026, 10, 12);
  return {
    session: { schema: 'kortix.session/2', session_id: 'session', threads: [] } as unknown as SessionLogPage['session'],
    generation: 1,
    threads: [],
    thread_id: threadId,
    has_more: false,
    messages: messages.map((m, i) => ({
      schema: 'kortix.session/2',
      v: 1,
      message_id: `msg_${String(i).padStart(4, '0')}`,
      thread_id: threadId,
      seq: i + 1,
      role: m.role,
      kind: 'turn',
      status: m.error ? 'error' : 'complete',
      in_context: true,
      error: m.error ? { code: m.error.name ?? 'error', message: m.error.message ?? '' } : null,
      created_at: new Date(at + i * 1000).toISOString(),
      completed_at: new Date(at + i * 1000 + 500).toISOString(),
      parent_message_id: null,
      blocks: m.text ? [{ type: 'text', id: `part_${i}`, text: m.text }] : [],
    })) as unknown as SessionLogPage['messages'],
  };
}
