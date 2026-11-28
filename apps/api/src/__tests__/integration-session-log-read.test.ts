/**
 * Integration test (real PostgreSQL, fresh migrated database, real routes): the
 * reads over the session log (P4.2, P8.2).
 *
 * One synthetic OpenCode session is stored as the journal ingest of `fromV1` of its v1 rows
 * under producer `opencode`, as the deleted OpenCode adapter journaled them, and `GET …/log`
 * serves it. The v1 reads (`GET …/transcript`, the open bundle's v1 window) are gone (P8.3):
 * the route answers 404 and the bundle's transcript part is the pointer only.
 * One tool output is 150,000 three-byte characters (450 kB): the log stores it by
 * reference (F3, P2.3). The Storage bucket is `helpers/fake-session-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { fromV1, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import { accountMembers, projectMembers, projectSessions, projects, sessionLogs, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { fakeSessionStorage } from './helpers/fake-session-storage';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';
import { syntheticRuntimeSession } from './helpers/synthetic-runtime-session';

const bucket = fakeSessionStorage();
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({ ...realSupabase, getSupabase: () => ({ storage: bucket.storage }) }));

// The box's own page (`GET /kortix/runtime/log`), as `GET …/log?live=1` reads it. No box runs here.
const realTransport = await import('../projects/lib/session-runtime-transport');
type BoxQuery = { thread: string | null; limit: number };
const boxReads: Array<{ externalId: string; query: BoxQuery }> = [];
let boxAnswer: (query: BoxQuery, signal: AbortSignal) => Promise<{ ok: true; body: unknown } | { ok: false; reason: string; status: number | null }> =
  async () => ({ ok: false, reason: 'no box in this test', status: null });
mock.module('../projects/lib/session-runtime-transport', () => ({
  ...realTransport,
  fetchRuntimeLogPage: async (target: { externalId: string }, query: BoxQuery, signal: AbortSignal) => {
    boxReads.push({ externalId: target.externalId, query });
    return boxAnswer(query, signal);
  },
}));

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_logreadroot000000000001';
const CHILD = 'ses_logreadchild00000000001';
const REV = 1_791_681_474_704_000;
/** Over 256 kB as UTF-8, under the mirror's 200,000-character cut. */
const WIDE_OUTPUT = '€'.repeat(150_000);

let project: SeededProject;
let session = '';
let nativeSession = '';
let ownerToken = '';
let sandboxToken = '';

const get = (path: string, token: string | null = ownerToken) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const base = (sessionId = session) => `/v1/projects/${project.project_id}/sessions/${sessionId}`;
/** One synthetic session's root and child, with one bash output over 256 kB. */
function history(turns: number) {
  const { root, child } = syntheticRuntimeSession({ root: ROOT, child: CHILD, turns });
  const bash = root.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'bash' && (p.state as { status: string }).status === 'completed')!;
  (bash.state as { output: string }).output = WIDE_OUTPUT;
  return { root, child };
}

/** Store one synthetic session in the log: the ingest of fromV1 of its v1 rows. */
async function storeInLog(sessionId: string, turns: number, options: { nativeThreads?: boolean } = {}) {
  const { root, child } = history(turns);
  await db.update(projectSessions).set({ runtimeSessionId: ROOT }).where(eq(projectSessions.sessionId, sessionId));
  const rows = [
    ...root.map((m) => ({ runtime_session_id: ROOT, info: m.info, parts: m.parts })),
    ...child.map((m) => ({ runtime_session_id: CHILD, info: m.info, parts: m.parts })),
  ];
  const log = fromV1({ session_id: sessionId, root_id: ROOT, rows: rows as unknown as V1Row[] }, { harness: 'opencode' });
  const producer = { harness: 'opencode', harness_version: '1.18.23', adapter_version: '1.0.0' };
  if (options.nativeThreads) for (const t of log.threads) delete t.ext;
  const { threads, ...patch } = log;
  const batch: SessionLogJournalRequest = {
    generation: 0,
    session: patch,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } }))),
    tombstones: [],
  };
  const outcome = await ingestSessionLogJournal({ sessionId, projectId: project.project_id, accountId: project.account_id }, batch);
  expect(outcome.status).toBe(200);
  // F3: the log row holds a preview and a reference; the object holds the output.
  const [offloaded] = await db.execute<{ n: number }>(sql`select count(*)::int as n from kortix.session_log_messages where session_id = ${sessionId} and record::text like '%kortix-attachment://%'`);
  expect(offloaded!.n).toBe(1);
  expect([...bucket.objects.keys()].filter((k) => k.startsWith(`${project.project_id}/${sessionId}/`))).toHaveLength(1);
  return { rows: rows.length, messages: batch.puts.length };
}

beforeAll(async () => {
  project = await seedProject('session-log-read');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  session = await seedSession(project, OWNER);
  nativeSession = await seedSession(project, OWNER);
  ownerToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-log-read-owner' })).secretKey;
  await db.insert(sessionSandboxes).values({ sandboxId: session, sessionId: session, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
  sandboxToken = (await createAccountToken({ accountId: project.account_id, userId: OWNER, projectId: project.project_id, sessionId: session, name: 'session-log-read-box' })).secretKey;
});

afterAll(async () => {
  // `guard_session_sandbox_identity` refuses to delete the box row (with an external id) of a
  // session that is not tombstoned: tombstone the sessions first.
  await db
    .update(projectSessions)
    .set({ metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb` })
    .where(eq(projectSessions.projectId, project.project_id));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

describe('the stored log is the only stored read (P8.3)', () => {
  test('the open bundle serves the log page and a pointer-only transcript part; GET …/transcript is gone', async () => {
    await storeInLog(session, 70);
    const bundle = (await (await get(`${base()}/open-bundle`)).json()) as Record<string, Record<string, unknown>>;
    expect(bundle.transcript).toEqual({ known: true, requested: false });
    // The open bundle's log leg: the first page of the root thread.
    const leg = bundle.log as { known: boolean; page: { thread_id: string; messages: Array<{ seq: number }>; has_more: boolean } };
    expect(leg.known).toBe(true);
    expect(leg.page.thread_id).toBe(ROOT);
    expect(leg.page.messages).toHaveLength(40);
    expect(leg.page.has_more).toBe(true);
    // F3: the log page serves the over-256 kB output as a preview with its reference.
    const all = (await (await get(`${base()}/log?limit=500`)).json()) as { messages: unknown[] };
    expect(JSON.stringify(all.messages)).toContain('kortix-attachment://');
    for (const path of ['transcript', 'transcript?shape=sync', `transcript?shape=sync&child=${CHILD}`]) {
      expect((await get(`${base()}/${path}`)).status).toBe(404);
    }
    expect((await get(`/v1/workspaces/${project.project_id}/sessions/${session}/transcript`)).status).toBe(404);
  });

  test('a tombstoned message leaves the log', async () => {
    const page = (await (await get(`${base()}/log?limit=5`)).json()) as { messages: Array<{ message_id: string }> };
    const victim = page.messages[0]!.message_id;
    const outcome = await ingestSessionLogJournal(
      { sessionId: session, projectId: project.project_id, accountId: project.account_id },
      { generation: 0, puts: [], threads: [], tombstones: [{ message_id: victim, rev: REV + 10_000 }] },
    );
    expect(outcome.status).toBe(200);
    const after = (await (await get(`${base()}/log?limit=500`)).json()) as typeof page;
    expect(after.messages.map((m) => m.message_id)).not.toContain(victim);
  });

  test('a session whose threads fromV1 did not build (the pi adapter writes them natively) is served from the log', async () => {
    await storeInLog(nativeSession, 6, { nativeThreads: true });
    const page = (await (await get(`${base(nativeSession)}/log?limit=500`)).json()) as { thread_id: string; threads: Array<{ thread_id: string }>; messages: Array<{ thread_id: string }> };
    expect(page.thread_id).toBe(ROOT);
    expect(page.threads.map((t) => t.thread_id).sort()).toEqual([CHILD, ROOT].sort());
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.every((m) => m.thread_id === ROOT)).toBe(true);
    const child = (await (await get(`${base(nativeSession)}/log?thread=${CHILD}`)).json()) as typeof page;
    expect(child.messages).toHaveLength(2);
  });
});

describe('GET .../log', () => {
  type Page = { session: { session_id?: string }; generation: number; threads: Array<{ thread_id: string }>; thread_id: string; messages: Array<{ seq: number; message_id: string }>; has_more: boolean };

  test('pages the root thread backwards by seq, ascending within a page, without the tombstoned message', async () => {
    const all: number[] = [];
    let before: number | null = null;
    let first: Page | null = null;
    for (;;) {
      const res = await get(`${base()}/log?limit=50${before === null ? '' : `&before_seq=${before}`}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Page;
      first ??= page;
      const seqs = page.messages.map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      all.unshift(...seqs);
      if (!page.has_more) break;
      before = seqs[0]!;
    }
    expect(first!.session.session_id).toBe(session);
    expect(first!.generation).toBe(0);
    expect(first!.threads.map((t) => t.thread_id).sort()).toEqual([CHILD, ROOT].sort());
    expect(first!.thread_id).toBe(ROOT);
    expect(new Set(all).size).toBe(all.length);
    // One seq is a gap: the message tombstoned above.
    expect(all.length).toBe(all.at(-1)! - all[0]! );
  });

  test('thread= reads the child thread', async () => {
    const res = await get(`${base()}/log?thread=${CHILD}`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.thread_id).toBe(CHILD);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
  });

  test('a session-bound token reads the log of its own session and its project siblings, and nowhere else', async () => {
    const other = await seedProject('session-log-read-other', { accountId: project.account_id });
    const otherSession = await seedSession(other, OWNER);
    try {
      const status = async (path: string) => (await get(`${path}/log`, sandboxToken)).status;
      // (a) its own session, (b) a sibling session of its project, (c) a session of another project.
      expect(await status(base())).toBe(200);
      expect(await status(base(nativeSession))).toBe(200);
      expect(await status(`/v1/projects/${other.project_id}/sessions/${otherSession}`)).toBe(403);
      const own = (await (await get(`${base()}/log?limit=500`, sandboxToken)).json()) as Page;
      const owner = (await (await get(`${base()}/log?limit=500`)).json()) as Page;
      expect(own).toEqual(owner);
    } finally {
      await db.delete(projects).where(eq(projects.projectId, other.project_id));
    }
  });

  test('a KaaB backend-origin sibling and another user\'s private session: the log refuses them', async () => {
    const MEMBER = crypto.randomUUID();
    await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: project.account_id, accountRole: 'member' });
    await insertIntoView(db, projectMembers, { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' });
    // Two KaaB sessions: one wrapper credential (OWNER) created both, each box acts for one end-user.
    const [backendA, backendB, memberSession] = [await seedSession(project, OWNER), await seedSession(project, OWNER), await seedSession(project, MEMBER)];
    await db.update(projectSessions).set({ origin: 'backend' }).where(sql`${projectSessions.sessionId} in (${backendA}, ${backendB})`);
    for (const id of [backendA, backendB, memberSession]) await storeInLog(id, 6);
    // `session` is OWNER's private session (the column default): a log is stored, so a 404 below is the gate, not a missing log.
    const [row] = await db.select({ visibility: projectSessions.visibility }).from(projectSessions).where(eq(projectSessions.sessionId, session));
    expect(row!.visibility).toBe('private');
    const boxToken = async (sessionId: string, userId: string) => {
      await db.insert(sessionSandboxes).values({ sandboxId: sessionId, sessionId, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
      return (await createAccountToken({ accountId: project.account_id, userId, projectId: project.project_id, sessionId, name: `session-log-read-${sessionId}` })).secretKey;
    };
    const backendBox = await boxToken(backendA, OWNER);
    const memberBox = await boxToken(memberSession, MEMBER);
    const memberToken = (await createAccountToken({ accountId: project.account_id, userId: MEMBER, name: 'session-log-read-member' })).secretKey;
    const status = async (sessionId: string, token: string) => (await get(`${base(sessionId)}/log`, token)).status;
    // The backend box reads its own session, never its sibling; the signed-in human reads both.
    expect(await status(backendA, backendBox)).toBe(200);
    expect(await status(backendB, backendBox)).toBe(404);
    expect(await status(backendB, ownerToken)).toBe(200);
    // Another user's private session: refused to the member and to the member's box; the owner reads it.
    expect(await status(session, memberToken)).toBe(404);
    expect(await status(session, memberBox)).toBe(404);
    expect(await status(memberSession, memberBox)).toBe(200);
    expect(await status(session, ownerToken)).toBe(200);
  });

  test('refuses a bad before_seq and limit; 404 for an unknown thread and without a log', async () => {
    expect((await get(`${base()}/log?before_seq=1.5`)).status).toBe(400);
    expect((await get(`${base()}/log?limit=501`)).status).toBe(400);
    const unknownThread = await get(`${base()}/log?thread=ses_not_a_thread`);
    expect(unknownThread.status).toBe(404);
    expect(((await unknownThread.json()) as { code?: string }).code).toBeUndefined();
    const empty = await seedSession(project, OWNER);
    // A session with no stored log yet (a new one) says so by code; an unknown thread does not.
    const missing = await get(`${base(empty)}/log`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No session log for this session', code: 'session_log_missing' });
    expect((await get(`${base()}/log`, null)).status).toBe(401);
  });
});

describe('GET .../log?live=1: the running box answers, else the stored log', () => {
  const EXT = 'sbx_live_read';
  type Page = { generation: number; thread_id: string; messages: Array<{ message_id: string; thread_id: string }>; source?: string };
  const boxPage = (over: Record<string, unknown> = {}) => ({
    session: { schema: 'kortix.session/2', session_id: live },
    generation: 0,
    threads: [{ thread_id: ROOT }],
    thread_id: ROOT,
    messages: [{ message_id: 'msg_box_only', thread_id: ROOT, seq: 10_000 }],
    has_more: true,
    ...over,
  });
  const read = async (path: string, token: string | null = ownerToken) => {
    const res = await get(path, token);
    return { status: res.status, body: (await res.json()) as Page };
  };
  /** A session with a stored log and a running box of its own: its box row keeps its external id. */
  let live = '';
  const setBox = (status: string) => db.update(sessionSandboxes).set({ status } as never).where(eq(sessionSandboxes.sessionId, live));

  beforeAll(async () => {
    live = await seedSession(project, OWNER);
    await storeInLog(live, 6);
    await db.insert(sessionSandboxes).values({ sandboxId: live, sessionId: live, externalId: EXT, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
  });
  afterAll(() => {
    boxAnswer = async () => ({ ok: false, reason: 'no box in this test', status: null });
  });

  test('the box page answers with source box; the box is asked for the root thread and the limit', async () => {
    boxAnswer = async () => ({ ok: true, body: boxPage() });
    const before = boxReads.length;
    const { status, body } = await read(`${base(live)}/log?live=1`);
    expect(status).toBe(200);
    expect(body.source).toBe('box');
    expect(body.messages.map((m) => m.message_id)).toEqual(['msg_box_only']);
    expect(boxReads.slice(before)).toEqual([{ externalId: EXT, query: { thread: null, limit: 40 } }]);
  });

  test('without live the stored log answers with source store, and the box is not asked', async () => {
    const before = boxReads.length;
    const { status, body } = await read(`${base(live)}/log`);
    expect(status).toBe(200);
    expect(body.source).toBe('store');
    expect(body.messages.map((m) => m.message_id)).not.toContain('msg_box_only');
    expect(boxReads.length).toBe(before);
  });

  test('thread= goes to the box; a box page of another thread is not served', async () => {
    boxAnswer = async () => ({ ok: true, body: boxPage() });
    const before = boxReads.length;
    const { status, body } = await read(`${base(live)}/log?live=true&thread=${CHILD}`);
    expect(status).toBe(200);
    expect(boxReads.slice(before)).toEqual([{ externalId: EXT, query: { thread: CHILD, limit: 40 } }]);
    expect(body.source).toBe('store');
    expect(body.thread_id).toBe(CHILD);
  });

  test('a box that does not answer: the stored log, after at most the 2 s budget', async () => {
    boxAnswer = (_query, signal) =>
      new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout', status: null }), { once: true }));
    const started = Date.now();
    const { status, body } = await read(`${base(live)}/log?live=1`);
    const ms = Date.now() - started;
    expect(status).toBe(200);
    expect(body.source).toBe('store');
    expect(body.thread_id).toBe(ROOT);
    expect(ms).toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThan(3_500);
  });

  // The budget covers the whole box read: resolving the box's address (a provider call on a cold
  // cache) as well as the request to it.
  test('a box read that does not settle within the budget, whatever it waits on: the stored log', async () => {
    boxAnswer = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, body: boxPage() }), 4_000));
    const started = Date.now();
    const { status, body } = await read(`${base(live)}/log?live=1`);
    const ms = Date.now() - started;
    expect(status).toBe(200);
    expect(body.source).toBe('store');
    expect(ms).toBeLessThan(3_000);
  });

  test('a burst of live reads of one session shares one box read', async () => {
    boxAnswer = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, body: boxPage() }), 300));
    const before = boxReads.length;
    const answers = await Promise.all(Array.from({ length: 20 }, () => read(`${base(live)}/log?live=1`)));
    expect(answers.map((a) => `${a.status} ${a.body.source}`)).toEqual(Array.from({ length: 20 }, () => '200 box'));
    expect(boxReads.length - before).toBe(1);
  });

  test('more than two different live reads of one session at once: the rest answer the stored log', async () => {
    boxAnswer = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, body: boxPage() }), 300));
    const before = boxReads.length;
    const answers = await Promise.all([40, 30, 20, 10].map((limit) => read(`${base(live)}/log?live=1&limit=${limit}`)));
    expect(answers.map((a) => a.body.source).sort()).toEqual(['box', 'box', 'store', 'store']);
    expect(boxReads.length - before).toBe(2);
  });

  test('a box page that is not a whole page, or of an older generation than the stored log: the stored log', async () => {
    boxAnswer = async () => ({ ok: true, body: { generation: 0, thread_id: ROOT, messages: [], has_more: false } });
    expect((await read(`${base(live)}/log?live=1`)).body.source).toBe('store');
    await db.update(sessionLogs).set({ generation: 2 }).where(eq(sessionLogs.sessionId, live));
    try {
      boxAnswer = async () => ({ ok: true, body: boxPage({ generation: 1 }) });
      expect((await read(`${base(live)}/log?live=1`)).body.source).toBe('store');
      boxAnswer = async () => ({ ok: true, body: boxPage({ generation: 2 }) });
      expect((await read(`${base(live)}/log?live=1`)).body.source).toBe('box');
    } finally {
      await db.update(sessionLogs).set({ generation: 0 }).where(eq(sessionLogs.sessionId, live));
    }
  });

  test('an older page (before_seq) and a session whose box is stopped read the stored log; the box is not asked', async () => {
    boxAnswer = async () => ({ ok: true, body: boxPage() });
    const before = boxReads.length;
    const older = await read(`${base(live)}/log?live=1&before_seq=20`);
    expect(older.status).toBe(200);
    expect(older.body.source).toBe('store');
    await setBox('stopped');
    try {
      const stopped = await read(`${base(live)}/log?live=1`);
      expect(stopped.status).toBe(200);
      expect(stopped.body.source).toBe('store');
    } finally {
      await setBox('active');
    }
    expect(boxReads.length).toBe(before);
  });

  test('a new session with no stored log: the running box answers; without live it is session_log_missing', async () => {
    const fresh = await seedSession(project, OWNER);
    await db.insert(sessionSandboxes).values({ sandboxId: fresh, sessionId: fresh, externalId: `${EXT}_fresh`, accountId: project.account_id, projectId: project.project_id, status: 'active', config: {}, metadata: {} });
    boxAnswer = async () => ({ ok: true, body: boxPage({ session: { schema: 'kortix.session/2', session_id: fresh } }) });
    const live = await read(`${base(fresh)}/log?live=1`);
    expect(live.status).toBe(200);
    expect(live.body.source).toBe('box');
    const stored = await get(`${base(fresh)}/log`);
    expect(stored.status).toBe(404);
    expect(((await stored.json()) as { code?: string }).code).toBe('session_log_missing');
  });

  test('the read gate runs first: a caller without access never reaches the box', async () => {
    boxAnswer = async () => ({ ok: true, body: boxPage() });
    const before = boxReads.length;
    expect((await get(`${base(live)}/log?live=1`, null)).status).toBe(401);
    expect(boxReads.length).toBe(before);
  });
});

test('inventory reports the durable project-default turn model instead of the creation pin', async () => {
  const id = await seedSession(project, OWNER);
  await storeInLog(id, 1);
  await db.update(projectSessions).set({ metadata: { model: 'kortix/deepseek-v4.1-flash', model_source: 'platform' } }).where(eq(projectSessions.sessionId, id));
  await db.update(sessionLogs).set({ record: sql`jsonb_set(${sessionLogs.record}, '{selection}', ${JSON.stringify({ agent: null, model: { provider: 'kortix', model: 'glm-5.3-flash' } })}::jsonb)` }).where(eq(sessionLogs.sessionId, id));
  const response = await get(`/v1/projects/${project.project_id}/sessions`);
  expect(response.status).toBe(200);
  const rows: Array<{ session_id: string; model: string | null; metadata: Record<string, unknown> }> = await response.json();
  for (const path of [`/v1/projects/${project.project_id}/sessions/${id}`, `/v1/sessions/${id}`]) {
    const detail = await get(path);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ model: 'kortix/glm-5.3-flash' });
  }
  for (const route of ['snapshot', 'open-bundle']) {
    for (const transcript of [0, 40]) {
      const bundle = await get(`${base(id)}/${route}?transcript=${transcript}`);
      expect(bundle.status).toBe(200);
      expect(await bundle.json()).toMatchObject({
        session: { model: 'kortix/glm-5.3-flash', metadata: { model: 'kortix/deepseek-v4.1-flash' } },
      });
    }
  }
  expect(rows.find((row) => row.session_id === id)).toMatchObject({
    model: 'kortix/glm-5.3-flash',
    metadata: { model: 'kortix/deepseek-v4.1-flash' },
  });
});
