/**
 * One QualiLoop test turn against the real agent: a QualiLoop conversation is
 * one Kortix session in the project `QUALILOOP_KORTIX_PROJECT_ID`, run as the
 * project's owner through the same session lifecycle a person's chat uses. The
 * first turn creates the session with the prompt; later turns go through the
 * durable prompt queue. The reply is the agent's text of the turn, read from
 * the session log once the turn ended, and the turn's trace goes to QualiLoop
 * before the reply returns (QualiLoop looks for it as soon as it has the reply).
 */
import { gzipSync } from 'node:zlib';
import { projectSessions, sessionLogMessages, sessionTurns } from '@kortix/db';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { projectsView } from '../../workspaces/rows';
import { readSessionLogPage } from '../session-log-read';
import {
  createSession,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
  resolveProjectAutomationActor,
} from '../session-lifecycle';
import { turnReply } from './reply';
import { buildTurnTrace, kortixSessionIdFor, type LogMessage } from './spans';

// Origin `user` (not a `system:` source): the test must meet the agent a person meets in their own chat.
const SOURCE = 'qualiloop' as const;
/** Under QualiLoop's longest reply timeout (600 s). */
const TURN_TIMEOUT_MS = 570_000;
const POLL_MS = 1_000;
/** How long an ended turn may wait for its log to be stored. */
const LOG_WAIT_MS = 20_000;

export class QualiloopTurnError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of the user messages after `afterSeq`: the prompts delivered since. */
async function userTextsAfter(sessionId: string, afterSeq: number): Promise<string[]> {
  const rows = await db
    .select({ text: sql<string | null>`(select string_agg(b->>'text', '') from jsonb_array_elements(${qualifiedColumn(sessionLogMessages.record)}->'blocks') b where b->>'type' = 'text')` })
    .from(sessionLogMessages)
    .where(and(eq(sessionLogMessages.sessionId, sessionId), eq(sessionLogMessages.role, 'user'), gt(sessionLogMessages.seq, afterSeq)));
  return rows.map((row) => row.text ?? '');
}

/**
 * Waits until the agent answered `prompt`: the prompt is in the session log, no
 * turn is open, and the last turn's log is stored. The prompt does not always
 * start a turn of its own: sent while a turn runs (a colleague's report woke
 * the session), it joins that turn. Waiting for a new turn token then waited
 * 570 s and answered QualiLoop with an empty reply (Core run 3, turn 6).
 */
async function awaitAnswer(sessionId: string, lastSeq: number, prompt: string, deadline: number): Promise<void> {
  const head = prompt.trim().slice(0, 200);
  let settledAt: number | null = null;
  while (Date.now() < deadline) {
    const [open] = await db
      .select({ token: sessionTurns.turnToken })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), ne(sessionTurns.state, 'ended')))
      .limit(1);
    const delivered = !open && (await userTextsAfter(sessionId, lastSeq)).some((text) => text.includes(head));
    if (!delivered) {
      settledAt = null;
    } else {
      const [last] = await db
        .select({ endReason: sessionTurns.endReason, endError: sessionTurns.endError, logDurableAt: sessionTurns.logDurableAt })
        .from(sessionTurns)
        .where(eq(sessionTurns.sessionId, sessionId))
        .orderBy(desc(sessionTurns.startedAt))
        .limit(1);
      if (last?.endReason === 'failed') {
        throw new QualiloopTurnError(`The agent's turn failed: ${last.endError?.message ?? 'no detail'}`);
      }
      settledAt ??= Date.now();
      if (last?.logDurableAt || Date.now() - settledAt > LOG_WAIT_MS) return;
    }
    await sleep(POLL_MS);
  }
  throw new QualiloopTurnError(`The agent did not finish the turn within ${TURN_TIMEOUT_MS / 1000} s.`);
}

/** Where a turn starts: the last log message before its prompt. */
interface TurnMark {
  lastSeq: number;
}

/**
 * Claims turn `index` of the session for this request, once. A retried request
 * (QualiLoop resends a turn after a network failure) finds the claim and
 * returns its mark: it waits for the same turn instead of sending the prompt
 * again. The claim and the check are one statement, so two requests at once
 * claim it once.
 */
async function claimTurn(sessionId: string, index: number, mark: TurnMark): Promise<TurnMark | null> {
  const key = String(index);
  const turns = sql`coalesce(${projectSessions.metadata}->'qualiloop_turns', '{}'::jsonb)`;
  const claimed = await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || jsonb_build_object('qualiloop_turns', ${turns} || jsonb_build_object(${key}::text, ${JSON.stringify(mark)}::jsonb))`,
    })
    .where(and(eq(projectSessions.sessionId, sessionId), sql`NOT (${turns} ? ${key}::text)`))
    .returning({ id: projectSessions.sessionId });
  if (claimed.length) return null;
  const [row] = await db
    .select({ mark: sql<TurnMark | null>`${projectSessions.metadata}->'qualiloop_turns'->${key}::text` })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return row?.mark ?? mark;
}

// ponytail: the last 100 log messages; a turn longer than that loses its first steps from the trace.
async function logTail(sessionId: string): Promise<LogMessage[]> {
  const page = await readSessionLogPage({ sessionId, threadId: null, beforeSeq: null, limit: 100 });
  return !page || page === 'unknown_thread' ? [] : page.messages.filter((m) => m.in_context !== false);
}

async function sendTrace(body: unknown): Promise<void> {
  const url = config.QUALILOOP_OTLP_TRACES_URL;
  const key = config.QUALILOOP_PROJECT_KEY;
  if (!url || !key) return;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Project-Key': key },
      body: gzipSync(JSON.stringify(body)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) logger.warn('[qualiloop] trace export refused', { status: response.status });
  } catch (error) {
    logger.warn('[qualiloop] trace export failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function runQualiloopTurn(input: { conversationId: string; turnIndex: number; prompt: string }): Promise<string> {
  const startedAtMs = Date.now();
  const projectId = config.QUALILOOP_KORTIX_PROJECT_ID!;
  const [project] = await db.select().from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1);
  if (!project) throw new QualiloopTurnError('QUALILOOP_KORTIX_PROJECT_ID names no project.');
  const userId = await resolveProjectAutomationActor(project.accountId);
  if (!userId) throw new QualiloopTurnError('The QualiLoop project has no owner to run as.');

  const sessionId = kortixSessionIdFor(projectId, input.conversationId);
  const [existing] = await db.select({ id: projectSessions.sessionId }).from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId)).limit(1);
  let mark: TurnMark = { lastSeq: 0 };
  if (!existing) {
    // The first prompt starts the session, so its claim is written with it. A retry
    // while the create runs gets the same session back from the idempotency key.
    const created = await createSession({
      source: SOURCE,
      project,
      userId,
      requestingPrincipalType: 'human',
      body: { session_id: sessionId, name: `QualiLoop ${input.conversationId}`.slice(0, 120), initial_prompt: input.prompt },
      metadata: { qualiloop_conversation_id: input.conversationId, qualiloop_turns: { [input.turnIndex]: mark } },
      idempotencyKey: `qualiloop-create:${sessionId}`,
    });
    if (created.error) {
      throw new QualiloopTurnError(String(created.error.body?.error ?? created.error.body?.message ?? 'The session could not start.'));
    }
  } else {
    mark = { lastSeq: Math.max(0, ...(await logTail(sessionId)).map((m) => m.seq)) };
    const earlier = await claimTurn(sessionId, input.turnIndex, mark);
    if (earlier) {
      mark = earlier;
    } else {
      const idempotencyKey = `qualiloop-prompt:${sessionId}:${input.turnIndex}`;
      await enqueueContinueSessionCommand({
        source: SOURCE,
        projectId: project.projectId,
        accountId: project.accountId,
        sessionId,
        actorUserId: userId,
        text: input.prompt,
        idempotencyKey,
      });
      drainSessionLifecycleQueue({ idempotencyKey, burst: false }).catch(() => {});
    }
  }
  const { lastSeq } = mark;

  await awaitAnswer(sessionId, lastSeq, input.prompt, startedAtMs + TURN_TIMEOUT_MS);
  const log = await logTail(sessionId);
  // The session's system prompt rides in a `context` message at the start: every model call of the turn saw it.
  const systemPrompt = log.find((m) => m.role === 'system')?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? null;
  const messages = log.filter((m) => m.seq > lastSeq && m.role !== 'system');
  const reply = turnReply(messages);

  await sendTrace(buildTurnTrace({
    conversationId: input.conversationId,
    turnIndex: input.turnIndex,
    input: input.prompt,
    output: reply,
    startedAtMs,
    endedAtMs: Date.now(),
    messages,
    systemPrompt,
    kortixSessionId: sessionId,
  }, config.INTERNAL_KORTIX_ENV));
  return reply;
}
