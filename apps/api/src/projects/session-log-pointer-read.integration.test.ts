import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  projectSessions,
  projects,
  sessionLogMessages,
  sessionLogThreads,
  sessionLogs,
} from '@kortix/db';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { readSessionLogPage } from './session-log-read';

/**
 * KRTX-4733: the session-open snapshot route reads the log page with `limit: 0`
 * for `?transcript=0` — the pointer read, documented "session, generation,
 * threads, no messages" — but the page still READ the newest record's whole
 * payload before answering, and threw the bytes away (`messages:
 * rows.slice(0, 0)`). A heavy session's newest record is multi-MB (tool
 * payloads; the page budget always serves the newest message however large it
 * is), so every session open paid its detoast + transfer: prod slow rows sat at
 * 1.1–4.8 s with `db;dur` at 90–98 % of wall, and the read scales with the
 * payload bytes (KRTX-4508 measured ~8 ms/MB loopback).
 *
 * The pointer read must not read any record payload. The wire shape is
 * unchanged: `messages: []` and `has_more: true` (older messages exist).
 *
 * Runs in the `db-suites` lane: one fresh migrated database per file.
 */
const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c821';
const PROJECT_ID = '00000000-0000-4000-a000-00000000c822';
const SESSION_ID = 'ses_pointerread0000000000001';

/** `readSessionLogPage` narrows to the page or the test fails naming what came back instead. */
function pageOf(page: Awaited<ReturnType<typeof readSessionLogPage>>) {
  if (page === null || page === 'unknown_thread')
    throw new Error(`expected a page, got ${String(page)}`);
  return page;
}

/** A synthetic message record whose stored jsonb is roughly `kilobytes` big (high-entropy text: the TOAST compression must not shrink the fixture). */
const recordOf = (kilobytes: number) => ({
  id: `msg-${Math.random().toString(36).slice(2)}`,
  blocks: [
    { type: 'text', id: 'b1', text: 'pointer-read fixture' },
    {
      type: 'tool_call',
      id: 'b2',
      state: 'complete',
      result: {
        content: [
          {
            type: 'text',
            text: Array.from({ length: kilobytes * 1024 }, () =>
              Math.random().toString(36).slice(2).slice(0, 1),
            ).join(''),
          },
        ],
      },
    },
  ],
});

async function seedMessage(sizeKilobytes: number): Promise<void> {
  seq += 1;
  await db.insert(sessionLogMessages).values({
    sessionId: SESSION_ID,
    messageId: `msg-${seq}`,
    threadId: 'root',
    seq,
    role: 'tool',
    kind: 'message',
    inContext: true,
    createdAt: new Date(),
    v: 2,
    producer: {},
    generation: 0,
    rev: 1_791_681_474_000 + seq,
    contentHash: `h${seq}`,
    record: recordOf(sizeKilobytes),
  });
}

let seq = 0;

async function cleanup(): Promise<void> {
  await db.execute(
    sql.raw(`DELETE FROM kortix.session_log_messages WHERE session_id = '${SESSION_ID}'`),
  );
  await db.execute(
    sql.raw(`DELETE FROM kortix.session_log_threads WHERE session_id = '${SESSION_ID}'`),
  );
  await db.execute(sql.raw(`DELETE FROM kortix.session_logs WHERE session_id = '${SESSION_ID}'`));
  await db.execute(
    sql.raw(`DELETE FROM kortix.project_sessions WHERE session_id = '${SESSION_ID}'`),
  );
  await db.execute(sql.raw(`DELETE FROM kortix.projects WHERE project_id = '${PROJECT_ID}'`));
  await db.execute(sql.raw(`DELETE FROM kortix.accounts WHERE account_id = '${ACCOUNT_ID}'`));
}

/** The fixture's base rows, after `cleanup()`. */
async function reseed(): Promise<void> {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'pointer-read-test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'pointer-read',
    repoUrl: 'https://example.test/pointer-read.git',
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    branchName: SESSION_ID,
  });
  await db.insert(sessionLogs).values({
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    v: 2,
    harnessCurrent: 'pi',
    restoreGrade: 'full',
    record: { session_id: SESSION_ID },
  });
  await db
    .insert(sessionLogThreads)
    .values({ sessionId: SESSION_ID, threadId: 'root', v: 2, record: { id: 'root' } });
}

describeWithDb('readSessionLogPage pointer read (limit 0) — real PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await reseed();
    seq = 0;
  });

  afterAll(async () => {
    await cleanup();
  });

  test('a pointer read does not read the newest record payload', async () => {
    // An older small message and a NEWEST record of ~24 MB: the payload read the
    // pointer used to serve (and slice away) costs its detoast on every open.
    await seedMessage(8);
    await seedMessage(24 * 1024);
    const t0 = performance.now();
    const page = pageOf(
      await readSessionLogPage({ sessionId: SESSION_ID, threadId: null, beforeSeq: null, limit: 0 }),
    );
    const ms = performance.now() - t0;
    // The wire shape is the contract (unchanged by the fix): a pointer read
    // carries no messages and says older ones exist.
    expect(page.messages.length).toBe(0);
    expect(page.has_more).toBe(true);
    expect(page.thread_id).toBe('root');
    // No 24 MB detoast on the pointer path: the probe + head + threads reads
    // answer in single-digit ms on loopback (KRTX-4508 measured ~8 ms/MB for the
    // payload), while the pre-fix payload read measures hundreds of ms.
    expect(ms).toBeLessThan(80);
  });

  test('a pointer read of an empty session answers has_more false', async () => {
    await cleanup();
    await reseed();
    seq = 0;
    const page = pageOf(
      await readSessionLogPage({ sessionId: SESSION_ID, threadId: null, beforeSeq: null, limit: 0 }),
    );
    expect(page.messages.length).toBe(0);
    expect(page.has_more).toBe(false);
  });
});
