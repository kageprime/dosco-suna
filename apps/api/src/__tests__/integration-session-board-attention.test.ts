/**
 * Integration test (real local PostgreSQL): what a session waits on, as the
 * session board reads it (projects/lib/session-board.ts `readSessionBoards`).
 *
 * Each of the three ask tables (questions, permissions, colleague access)
 * marks its session `needs_input`, on the asking session and on the session a
 * person opens for a hidden worker (`surface_session_id`). A question outranks
 * an approval. An answered, decided or expired ask waits on nobody.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { projectSessions, sessionColleagueAccess } from '@kortix/db';

const { db } = await import('../shared/db');
const { clearOpenQuestions, recordPendingQuestion } = await import('../projects/lib/pending-questions');
const { decidePendingPermission, recordPendingPermission } = await import('../projects/lib/pending-permissions');
const { askExpiresAt } = await import('../projects/lib/session-asks');
const { readSessionBoards } = await import('../projects/lib/session-board');
const { seedProject } = await import('./helpers/integration-fixtures');

type SeededProject = Awaited<ReturnType<typeof seedProject>>;
let project: SeededProject;

async function seedSession(): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    status: 'running',
  });
  return sessionId;
}

const scope = (sessionId: string) => ({ accountId: project.account_id, projectId: project.project_id, sessionId });

const askQuestion = (sessionId: string, requestId: string, surfaceSessionId: string | null = null) =>
  recordPendingQuestion({
    ...scope(sessionId),
    requestId,
    surfaceSessionId,
    questions: [{ question: 'Which way?', header: 'Pick', options: [] }],
  });

async function askPermission(sessionId: string, requestId: string, surfaceSessionId = sessionId, expiresAt = askExpiresAt()) {
  const recorded = await recordPendingPermission({
    ...scope(sessionId),
    surfaceSessionId,
    requestId,
    runtimeSessionId: 'ses_root',
    tool: 'bash',
    permission: 'bash',
    patterns: ['git push origin main'],
    args: { command: 'git push origin main' },
    argsHash: 'a'.repeat(64),
    expiresAt,
  });
  if (!recorded) throw new Error(`permission ask ${requestId} was not stored`);
  return recorded;
}

const askColleagueAccess = (sessionId: string, surfaceSessionId: string | null = null, decidedAt: string | null = null) =>
  db.insert(sessionColleagueAccess).values({
    ...scope(sessionId),
    surfaceSessionId,
    title: 'synthetic task',
    secrets: ['SYNTHETIC_KEY'],
    accessHash: 'h',
    expiresAt: askExpiresAt(),
    decidedAt,
    decision: decidedAt ? 'allow' : null,
  });

/** `[attention, board_state]` of each session, in the order given. */
async function boards(sessionIds: string[]) {
  const rows = sessionIds.map((sessionId) => ({ sessionId, status: 'running' as const, metadata: {} }));
  const read = await readSessionBoards(rows, new Map());
  return sessionIds.map((id) => [read.get(id)?.attention, read.get(id)?.board_state]);
}

beforeAll(async () => {
  project = await seedProject('session-board-attention');
});

describe('readSessionBoards: what a session waits on', () => {
  test('a question, a permission and a colleague-access ask each mark their session needs_input', async () => {
    const [questioned, permitted, colleague, quiet] = await Promise.all([seedSession(), seedSession(), seedSession(), seedSession()]);
    await askQuestion(questioned, 'que_1');
    await askPermission(permitted, 'perm_1');
    await askColleagueAccess(colleague);
    expect(await boards([questioned, permitted, colleague, quiet])).toEqual([
      ['question', 'needs_input'],
      ['approval', 'needs_input'],
      ['approval', 'needs_input'],
      [null, 'idle'],
    ]);
  });

  test("a hidden worker's ask of each kind marks the session a person opens for it", async () => {
    const [onQuestion, onPermission, onColleague] = await Promise.all([seedSession(), seedSession(), seedSession()]);
    const [w1, w2, w3] = await Promise.all([seedSession(), seedSession(), seedSession()]);
    await askQuestion(w1, 'que_worker', onQuestion);
    await askPermission(w2, 'perm_worker', onPermission);
    await askColleagueAccess(w3, onColleague);
    // Read the surfaces alone: only the `surface_session_id` filter finds the workers' asks.
    expect(await boards([onQuestion, onPermission, onColleague])).toEqual([
      ['question', 'needs_input'],
      ['approval', 'needs_input'],
      ['approval', 'needs_input'],
    ]);
    expect(await boards([w1, w2, w3])).toEqual([
      ['question', 'needs_input'],
      ['approval', 'needs_input'],
      ['approval', 'needs_input'],
    ]);
  });

  test('a question outranks an approval on the same session', async () => {
    const sessionId = await seedSession();
    await askPermission(sessionId, 'perm_2');
    await askColleagueAccess(sessionId);
    await askQuestion(sessionId, 'que_2');
    expect(await boards([sessionId])).toEqual([['question', 'needs_input']]);
  });

  test('an answered, decided or expired ask waits on nobody', async () => {
    const [answered, decided, expired, colleagueDecided] = await Promise.all([seedSession(), seedSession(), seedSession(), seedSession()]);
    await askQuestion(answered, 'que_done');
    expect(await clearOpenQuestions(answered, { requestId: 'que_done' })).toBe(1);
    const ask = await askPermission(decided, 'perm_done');
    expect(await decidePendingPermission({ id: ask.id, decision: 'once', decidedBy: null })).toBe(true);
    await askPermission(expired, 'perm_expired', expired, new Date(Date.now() - 1_000).toISOString());
    await askColleagueAccess(colleagueDecided, null, new Date().toISOString());
    expect(await boards([answered, decided, expired, colleagueDecided])).toEqual([
      [null, 'idle'],
      [null, 'idle'],
      [null, 'idle'],
      [null, 'idle'],
    ]);
  });
});
