import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SessionLogPage } from '@kortix/api-contract/session-log';
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
 * KRTX-4508: `GET /v1/projects/:id/sessions/:id/log` read a whole window of
 * stored records per request and a heavy session's page carried tens of MB —
 * the read scales with the page payload, and the fleet's session-log pollers
 * pushed the route's p95 to 1074–2240 ms while ordinary sessions stayed at
 * 40 ms. The page keeps the window's newest run within
 * `SESSION_LOG_PAGE_MAX_BYTES` (`pg_column_size` of the stored record) and
 * answers `has_more: true` for the tail it drops.
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

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c811';
const PROJECT_ID = '00000000-0000-4000-a000-00000000c812';
const SESSION_ID = 'ses_pagebudget00000000000001';

/** `readSessionLogPage` narrows to the page or the test fails naming what came back instead. */
function pageOf(page: Awaited<ReturnType<typeof readSessionLogPage>>): SessionLogPage {
  if (page === null || page === 'unknown_thread')
    throw new Error(`expected a page, got ${String(page)}`);
  return page;
}

/** A synthetic message record whose stored jsonb is roughly `kilobytes` big (high-entropy text: the TOAST compression must not shrink the fixture). */
const recordOf = (kilobytes: number, seq: number) => ({
  id: `msg-${Math.random().toString(36).slice(2)}`,
  seq,
  blocks: [
    { type: 'text', id: 'b1', text: 'page-budget fixture' },
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
    record: recordOf(sizeKilobytes, seq),
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

describeWithDb('GET …/log page budget — real PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await reseed();
    seq = 0;
    // Six messages of ~900 kB of high-entropy jsonb each (the jsonb wrapper adds ~2 %;
    // two fit under the default 2 MiB budget, a third overflows it).
    for (let i = 0; i < 6; i++) await seedMessage(900);
  });

  afterAll(async () => {
    await cleanup();
  });

  test('a page whose payload over the budget keeps the newest run and answers has_more', async () => {
    const page = pageOf(
      await readSessionLogPage({
        sessionId: SESSION_ID,
        threadId: null,
        beforeSeq: null,
        limit: 40,
      }),
    );
    expect(page.messages.length).toBe(2);
    // Oldest first inside the page.
    expect(page.messages[0].seq).toBe(5);
    expect(page.messages[1].seq).toBe(6);
    expect(page.has_more).toBe(true);
    expect(page.thread_id).toBe('root');
    expect(page.generation).toBe(0);
  });

  test('the older window continues after the kept run', async () => {
    const page = pageOf(
      await readSessionLogPage({ sessionId: SESSION_ID, threadId: null, beforeSeq: 5, limit: 40 }),
    );
    expect(page.messages.length).toBe(2);
    expect(page.messages[0].seq).toBe(3);
    expect(page.messages[1].seq).toBe(4);
    expect(page.has_more).toBe(true);
  });

  test('a window under the budget keeps every message and answers has_more only when older rows exist', async () => {
    // One small message: the whole window fits, and nothing older exists.
    await cleanup();
    await reseed();
    seq = 0;
    await seedMessage(4);
    const page = pageOf(
      await readSessionLogPage({
        sessionId: SESSION_ID,
        threadId: null,
        beforeSeq: null,
        limit: 40,
      }),
    );
    expect(page.messages.length).toBe(1);
    expect(page.messages[0].seq).toBe(1);
    expect(page.has_more).toBe(false);
  });

  test('the newest message is served however large it is', async () => {
    await cleanup();
    await reseed();
    seq = 0;
    // The NEWEST message is the 3 MB one: over the budget whole, it is served
    // anyway (the first window row has no budget check); the smaller older one
    // is the dropped tail.
    await seedMessage(8);
    await seedMessage(config.SESSION_LOG_PAGE_MAX_BYTES / 1024 + 1024);
    const page = pageOf(
      await readSessionLogPage({
        sessionId: SESSION_ID,
        threadId: null,
        beforeSeq: null,
        limit: 40,
      }),
    );
    expect(page.messages.length).toBe(1);
    expect(page.messages[0].seq).toBe(2);
    // The smaller older message went nowhere: it exists, so the page says so.
    expect(page.has_more).toBe(true);
  });
});

/** The fixture's base rows, after `cleanup()`. */
async function reseed(): Promise<void> {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'page-budget-test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'page-budget',
    repoUrl: 'https://example.test/page-budget.git',
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
