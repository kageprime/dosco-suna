// Which inbox asks are closed (audit finding 05): a `question` or `permission`
// row whose ask a person answered, dismissed or decided, or that expired.
// The inbox returns them `resolved: true`, and "Needs you" leaves them out.
// Read-time, no stored state: the ask tables are the truth, and a row never
// goes stale against them.
//
// The link is the row's dedupe key, `question:<session_id>:<request_id>` or
// `permission:<session_id>:<request_id>` (`session-push.ts`), the same
// (session_id, request_id) pair the ask tables are unique on. A question row
// without a key falls back to the digest's session rule: resolved when the
// session asked questions and none is open now. An ask with no stored row
// (nothing to read) stays open: a person may still have to answer it.
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { sessionPendingPermissions, sessionPendingQuestions } from '@kortix/db';
import { db } from '../shared/db';

export interface AskRow {
  notificationId: string;
  kind: string;
  sessionId: string | null;
  dedupeKey: string | null;
}

export interface AskKey {
  table: 'question' | 'permission';
  sessionId: string;
  requestId: string;
}

/** The ask a row names, or null: not an ask kind, no session, or no key in the push format. */
export function askKeyOf(row: AskRow): AskKey | null {
  if ((row.kind !== 'question' && row.kind !== 'permission') || !row.sessionId || !row.dedupeKey) return null;
  const prefix = `${row.kind}:${row.sessionId}:`;
  if (!row.dedupeKey.startsWith(prefix)) return null;
  const requestId = row.dedupeKey.slice(prefix.length);
  return requestId ? { table: row.kind, sessionId: row.sessionId, requestId } : null;
}

/** What the ask tables say: closed pairs, open pairs, and sessions with questions none of which is open. */
export interface AskStates {
  closed: ReadonlySet<string>;
  open: ReadonlySet<string>;
  answeredSessions: ReadonlySet<string>;
}

const pairKey = (table: AskKey['table'], sessionId: string, requestId: string) => `${table}\u0000${sessionId}\u0000${requestId}`;

/** The ids of `rows` whose ask is closed, from `states`. Pure. */
export function resolvedAskIds(rows: readonly AskRow[], states: AskStates): Set<string> {
  const resolved = new Set<string>();
  for (const row of rows) {
    const key = askKeyOf(row);
    if (key) {
      const pair = pairKey(key.table, key.sessionId, key.requestId);
      if (states.closed.has(pair)) resolved.add(row.notificationId);
      // A stored ask decides it; with none, a question falls back to its session.
      else if (!states.open.has(pair) && key.table === 'question' && states.answeredSessions.has(key.sessionId)) {
        resolved.add(row.notificationId);
      }
      continue;
    }
    if (row.kind === 'question' && row.sessionId && states.answeredSessions.has(row.sessionId)) {
      resolved.add(row.notificationId);
    }
  }
  return resolved;
}

/** Read the ask tables for `rows`: at most three queries, none when no row is an ask. */
async function loadAskStates(rows: readonly AskRow[]): Promise<AskStates> {
  const closed = new Set<string>();
  const open = new Set<string>();
  const keys = rows.flatMap((row) => {
    const key = askKeyOf(row);
    return key ? [key] : [];
  });
  const questionKeys = keys.filter((key) => key.table === 'question');
  const permissionKeys = keys.filter((key) => key.table === 'permission');
  const questionSessions = [
    ...new Set(rows.flatMap((row) => (row.kind === 'question' && row.sessionId ? [row.sessionId] : []))),
  ];
  const [questions, permissions, sessions] = await Promise.all([
    questionKeys.length === 0
      ? []
      : db
          .select({
            sessionId: sessionPendingQuestions.sessionId,
            requestId: sessionPendingQuestions.requestId,
            closed: sql<boolean>`(${sessionPendingQuestions.answeredAt} IS NOT NULL OR ${sessionPendingQuestions.expiresAt} <= NOW())`,
          })
          .from(sessionPendingQuestions)
          .where(
            or(
              ...questionKeys.map((key) =>
                and(eq(sessionPendingQuestions.sessionId, key.sessionId), eq(sessionPendingQuestions.requestId, key.requestId)),
              ),
            ),
          ),
    permissionKeys.length === 0
      ? []
      : db
          .select({
            sessionId: sessionPendingPermissions.sessionId,
            requestId: sessionPendingPermissions.requestId,
            closed: sql<boolean>`(${sessionPendingPermissions.decidedAt} IS NOT NULL OR ${sessionPendingPermissions.expiresAt} <= NOW())`,
          })
          .from(sessionPendingPermissions)
          .where(
            or(
              ...permissionKeys.map((key) =>
                and(eq(sessionPendingPermissions.sessionId, key.sessionId), eq(sessionPendingPermissions.requestId, key.requestId)),
              ),
            ),
          ),
    // The digest's rule (`answeredQuestionSessions` in digest.ts); an expired ask is closed, as in session-asks.ts.
    questionSessions.length === 0
      ? []
      : db
          .select({
            sessionId: sessionPendingQuestions.sessionId,
            open: sql<boolean>`bool_or(${sessionPendingQuestions.answeredAt} IS NULL AND (${sessionPendingQuestions.expiresAt} IS NULL OR ${sessionPendingQuestions.expiresAt} > NOW()))`,
          })
          .from(sessionPendingQuestions)
          .where(inArray(sessionPendingQuestions.sessionId, questionSessions))
          .groupBy(sessionPendingQuestions.sessionId),
  ]);
  for (const row of questions) (row.closed ? closed : open).add(pairKey('question', row.sessionId, row.requestId));
  for (const row of permissions) (row.closed ? closed : open).add(pairKey('permission', row.sessionId, row.requestId));
  return {
    closed,
    open,
    answeredSessions: new Set(sessions.filter((row) => !row.open).map((row) => row.sessionId)),
  };
}

/** The ids of `rows` whose question or permission ask is closed. */
export async function resolvedAskNotifications(rows: readonly AskRow[]): Promise<Set<string>> {
  if (!rows.some((row) => (row.kind === 'question' || row.kind === 'permission') && row.sessionId)) return new Set();
  return resolvedAskIds(rows, await loadAskStates(rows));
}
