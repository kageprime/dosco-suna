// The inbox's resolved rule (audit finding 05), pure: a question or permission
// row is resolved when its ask is closed. The DB read is covered by
// inbox-read.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import { askKeyOf, resolvedAskIds, type AskRow, type AskStates } from './inbox-resolution';

const SESSION = 'session-1';
const row = (id: string, kind: string, dedupeKey: string | null, sessionId: string | null = SESSION): AskRow => ({
  notificationId: id,
  kind,
  sessionId,
  dedupeKey,
});
const pair = (table: 'question' | 'permission', requestId: string, sessionId = SESSION) =>
  `${table}\u0000${sessionId}\u0000${requestId}`;
const states = (input: Partial<{ closed: string[]; open: string[]; answeredSessions: string[] }>): AskStates => ({
  closed: new Set(input.closed ?? []),
  open: new Set(input.open ?? []),
  answeredSessions: new Set(input.answeredSessions ?? []),
});

describe('askKeyOf', () => {
  test('reads the session push dedupe key', () => {
    expect(askKeyOf(row('n1', 'question', `question:${SESSION}:req-1`))).toEqual({
      table: 'question',
      sessionId: SESSION,
      requestId: 'req-1',
    });
    expect(askKeyOf(row('n2', 'permission', `permission:${SESSION}:per:2`))).toEqual({
      table: 'permission',
      sessionId: SESSION,
      requestId: 'per:2',
    });
  });

  test('no key for other kinds, a missing session, or a foreign key format', () => {
    expect(askKeyOf(row('n1', 'turn_error', `turn:${SESSION}:m1`))).toBeNull();
    expect(askKeyOf(row('n2', 'question', 'question:x:req-1', null))).toBeNull();
    expect(askKeyOf(row('n3', 'question', `turn:${SESSION}:m1`))).toBeNull();
    expect(askKeyOf(row('n4', 'question', null))).toBeNull();
  });
});

describe('resolvedAskIds', () => {
  test('an answered question and a decided permission are resolved; open ones are not', () => {
    const rows = [
      row('answered', 'question', `question:${SESSION}:q1`),
      row('open', 'question', `question:${SESSION}:q2`),
      row('decided', 'permission', `permission:${SESSION}:p1`),
      row('waiting', 'permission', `permission:${SESSION}:p2`),
    ];
    const ids = resolvedAskIds(
      rows,
      states({ closed: [pair('question', 'q1'), pair('permission', 'p1')], open: [pair('question', 'q2'), pair('permission', 'p2')] }),
    );
    expect([...ids].sort()).toEqual(['answered', 'decided']);
  });

  test('an open question stays open even when the session has answered others', () => {
    const ids = resolvedAskIds([row('open', 'question', `question:${SESSION}:q2`)], states({ open: [pair('question', 'q2')], answeredSessions: [SESSION] }));
    expect(ids.size).toBe(0);
  });

  test('a question with no stored ask or no key follows its session: resolved when none is open', () => {
    const rows = [row('unkeyed', 'question', null), row('unstored', 'question', `question:${SESSION}:q9`)];
    expect([...resolvedAskIds(rows, states({ answeredSessions: [SESSION] }))].sort()).toEqual(['unkeyed', 'unstored']);
    expect(resolvedAskIds(rows, states({})).size).toBe(0);
  });

  test('a permission with no stored ask stays open; other kinds are never resolved', () => {
    const rows = [
      row('unstored', 'permission', `permission:${SESSION}:p9`),
      row('error', 'turn_error', `turn:${SESSION}:m1`),
      row('failed', 'automation_failed', null, null),
    ];
    expect(resolvedAskIds(rows, states({ answeredSessions: [SESSION] })).size).toBe(0);
  });
});
