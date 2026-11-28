import { describe, expect, test } from 'bun:test';
import type { SessionLogPage } from '@kortix/api-contract/session-log';
import { FULL_ANSWER_CHARS, lastTurnAnswerOf } from './session-last-answer';

type LogMessage = SessionLogPage['messages'][number];
type Block = LogMessage['blocks'][number];

let seq = 0;
function message(role: 'user' | 'assistant' | 'system', blocks: Block[], extra: Partial<LogMessage> = {}): LogMessage {
  seq += 1;
  return {
    schema: 'kortix.session/2',
    v: 1,
    message_id: `msg_${seq}`,
    thread_id: 'root',
    seq,
    role,
    kind: 'turn',
    status: 'complete',
    in_context: true,
    error: null,
    created_at: null,
    completed_at: null,
    parent_message_id: null,
    blocks,
    ...extra,
  } as unknown as LogMessage;
}
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', id: `p${seq}`, text: t, ...extra }) as unknown as Block;
const tool = () => ({ type: 'tool_call', id: `t${seq}`, name: 'bash', input: {}, status: 'complete' }) as unknown as Block;
const digest = { maxChars: 700 };

describe('lastTurnAnswerOf', () => {
  test('the newest assistant text after the last user message; the id is the message that carried it', () => {
    const answer = lastTurnAnswerOf(
      [
        message('user', [text('first')]),
        message('assistant', [text('old answer')]),
        message('user', [text('second')]),
        message('assistant', [text('Reading.')]),
        message('assistant', [text('Found 2 errors.'), tool()]),
        message('assistant', [tool()]),
      ],
      digest,
    );
    expect(answer).toEqual({ id: `msg_${seq - 1}`, text: 'Found 2 errors.', error: null });
  });

  test('no assistant message after the last user message answers null', () => {
    expect(lastTurnAnswerOf([message('assistant', [text('a')]), message('user', [text('q')])], digest)).toBeNull();
    expect(lastTurnAnswerOf([], digest)).toBeNull();
  });

  test('the error is the newest assistant message\'s, named by its code; text may come from an older one', () => {
    const answer = lastTurnAnswerOf(
      [
        message('user', [text('go')]),
        message('assistant', [text('Partial.')]),
        message('assistant', [], { status: 'error', error: { code: 'provider_error', message: 'model overloaded' } }),
      ],
      digest,
    );
    expect(answer).toEqual({ id: `msg_${seq - 1}`, text: 'Partial.', error: { name: 'provider_error', message: 'model overloaded' } });
  });

  test('a compaction inside the turn does not end it', () => {
    const answer = lastTurnAnswerOf(
      [
        message('user', [text('long task')]),
        message('assistant', [text('Step 1 done.')]),
        message('user', [text('summary of the conversation')], { kind: 'compaction' }),
      ],
      digest,
    );
    expect(answer?.text).toBe('Step 1 done.');
  });

  test('system and context messages are no answer', () => {
    const answer = lastTurnAnswerOf(
      [
        message('user', [text('q')]),
        message('assistant', [text('All steps done.')]),
        message('assistant', [text('context dump')], { kind: 'context' }),
        message('system', [text('system note')]),
      ],
      digest,
    );
    expect(answer?.text).toBe('All steps done.');
  });

  test('synthetic text is not the answer', () => {
    const answer = lastTurnAnswerOf(
      [message('user', [text('q')]), message('assistant', [text('Real.')]), message('assistant', [text('reminder', { synthetic: true })])],
      digest,
    );
    expect(answer?.text).toBe('Real.');
  });

  test('a digest answer is one line, cut at maxChars with an ellipsis', () => {
    const answer = lastTurnAnswerOf([message('user', [text('q')]), message('assistant', [text('a\n\nb   c'), text('d'.repeat(20))])], { maxChars: 10 });
    expect(answer?.text).toBe('a b c ddd…');
  });

  test('a full answer keeps its lines and says where it was cut', () => {
    const long = 'x'.repeat(FULL_ANSWER_CHARS + 5);
    expect(lastTurnAnswerOf([message('user', [text('q')]), message('assistant', [text('line 1\nline 2')])], { ...digest, full: true })?.text).toBe('line 1\nline 2');
    expect(lastTurnAnswerOf([message('user', [text('q')]), message('assistant', [text(long)])], { ...digest, full: true })?.text).toBe(
      `${'x'.repeat(FULL_ANSWER_CHARS)}…[truncated: ${FULL_ANSWER_CHARS} of ${FULL_ANSWER_CHARS + 5} chars]`,
    );
  });

  test('a stored text (F3 preview) says it is a preview of a larger stored text', () => {
    const answer = lastTurnAnswerOf(
      [message('user', [text('q')]), message('assistant', [text('preview…', { ref: 'kortix-attachment://p/s/a', bytes: 300_000 })])],
      { ...digest, full: true },
    );
    expect(answer?.text).toBe('preview……[truncated: a stored text of 300000 bytes]');
  });
});
