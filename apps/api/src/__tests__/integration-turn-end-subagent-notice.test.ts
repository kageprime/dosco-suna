/**
 * Integration test (real local PostgreSQL): a background subagent's turn end
 * tells its parent even when another writer closed the turn first.
 *
 * Two writers close a turn: the daemon's `turn_end` relay (`settleTurnEnd`) and
 * the session-list read (`settleCompletedInboxTurns`), which closes a turn the
 * box reports over. The parent's agents line polls its children every 5 s while
 * one works, so the read often closes the child's turn ~0.5 s before the relay
 * arrives. The relay then finds it `already_closed`. Before this fix only a relay
 * that closed the turn told the parent, so the parent never heard the child
 * finish and its chat stalled on "I've asked the writer…".
 *
 * Real: the session rows, the turn record, `settleTurnEnd`, the settled check and
 * the parent's `continue_session` row with its idempotency key. Stubbed: the
 * child's last answer (the stored session log), the forwarded reconcile, the push notifier and the drain
 * kick. `mock.module` is process-global: the db-suites lane runs each file alone.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';
import { sql } from 'drizzle-orm';

mock.module('../projects/session-lifecycle/forwarded-strand-reconcile', () => ({
  reconcileForwardedTurnsAtEnd: async () => undefined,
}));
const realPush = await import('../notifications/session-push');
mock.module('../notifications/session-push', () => ({ ...realPush, notifySessionEvent: async () => undefined }));
const realLastAnswer = await import('../projects/lib/session-last-answer');
mock.module('../projects/lib/session-last-answer', () => ({
  ...realLastAnswer,
  readLastTurnAnswer: async () => ({ id: 'msg_answer', text: 'Saved the comparison.', error: null }),
}));
const realLifecycleDrain = await import('../projects/session-lifecycle/drain');
mock.module('../projects/session-lifecycle/drain', () => ({ ...realLifecycleDrain, drainSessionLifecycleQueue: async () => undefined }));
// Collect the detached turn-end work, so each test awaits it instead of a clock.
const realDrain = { ...(await import('../shared/drain')) };
let detached: Promise<unknown>[] = [];
mock.module('../shared/drain', () => ({
  ...realDrain,
  trackDetached: (work: Promise<unknown>) => {
    detached.push(work);
    realDrain.trackDetached(work);
  },
}));

const { db } = await import('../shared/db');
const { settleTurnEnd } = await import('../projects/routes/turn-stream-handlers');
const { acceptSandboxTurn, beginSandboxTurn, clearSandboxTurn } = await import('../projects/sandbox-turn-lifecycle');
const { seedProject } = await import('./helpers/integration-fixtures');

const RUNTIME_SESSION = 'ses_root';
let project: Awaited<ReturnType<typeof seedProject>>;
let parentId: string;
let childId: string;

const responder = {
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
};
const background = () => ({ notify_parent: true, spawned_by_session: parentId });

async function seedSession(sessionId: string, opts: { parent?: string; metadata?: Record<string, unknown>; box?: boolean } = {}) {
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    status: 'running',
    parentSessionId: opts.parent ?? null,
    metadata: opts.metadata ?? {},
  });
  if (!opts.box) return;
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id)
    VALUES (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid, 'active', ${`ext-${sessionId}`})`);
}

/** The child's runtime accepted a prompt for `messageId`: the turn runs. */
async function startTurn(messageId: string): Promise<string> {
  const token = `tok-${messageId}`;
  const identity = { runtimeSessionId: RUNTIME_SESSION, messageId };
  await beginSandboxTurn({ sandboxId: childId }, { token, ...identity });
  expect(await acceptSandboxTurn({ sandboxId: childId }, token, identity)).toBe(true);
  return token;
}

/** The child daemon's `turn_end` relay, and the detached work it started. Returns the ledger outcome. */
async function endTurn(messageId: string | null): Promise<string> {
  const response = await settleTurnEnd(
    responder,
    { kind: 'turn_end', status: 'idle', runtime_session_id: RUNTIME_SESSION, ...(messageId ? { turn_message_id: messageId } : {}) },
    {
      projectId: project.project_id,
      sessionId: childId,
      childSession: true,
      turnStreamMetadata: background(),
      turnStreamSession: { accountId: project.account_id, createdBy: null, origin: 'user' },
    },
  );
  await Promise.all(detached);
  const body = (await response.json()) as { turn_completion: { outcome: string } };
  return body.turn_completion.outcome;
}

async function parentNotices(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT idempotency_key FROM kortix.session_lifecycle_commands
    WHERE session_id = ${parentId} AND command_type = 'continue_session' AND source = 'system:subagent-finished'`);
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{ idempotency_key: string }>;
  return rows.map((row) => row.idempotency_key);
}

beforeAll(async () => {
  project = await seedProject('turn-end-subagent-notice');
});

// No cleanup: the db-suites lane gives this file its own database and drops it.
beforeEach(async () => {
  detached = [];
  parentId = crypto.randomUUID();
  childId = crypto.randomUUID();
  await seedSession(parentId);
  await seedSession(childId, { parent: parentId, metadata: background(), box: true });
});

describe('a background subagent turn end tells its parent', () => {
  test('the relay closes the turn: the parent hears it once', async () => {
    await startTurn('msg_closed');
    expect(await endTurn('msg_closed')).toBe('closed');
    expect(await parentNotices()).toEqual([`subagent-finished:${childId}:msg_closed`]);
  });

  test('the session-list read closed the turn first: the late relay still tells the parent, once', async () => {
    const token = await startTurn('msg_read_first');
    // What `settleCompletedInboxTurns` does when the box reports the turn over.
    expect(await clearSandboxTurn(childId, token, undefined, 'completed')).toBe(true);
    expect(await endTurn('msg_read_first')).toBe('already_closed');
    expect(await parentNotices()).toEqual([`subagent-finished:${childId}:msg_read_first`]);
    // The daemon re-sends the same end: the key already exists.
    expect(await endTurn('msg_read_first')).toBe('already_closed');
    expect(await parentNotices()).toHaveLength(1);
  });

  test('a late relay while the child already runs its next turn tells nobody: the child is not finished', async () => {
    const token = await startTurn('msg_old');
    expect(await clearSandboxTurn(childId, token, undefined, 'completed')).toBe(true);
    await startTurn('msg_next');
    expect(await endTurn('msg_old')).toBe('already_closed');
    expect(await parentNotices()).toEqual([]);
  });
});
