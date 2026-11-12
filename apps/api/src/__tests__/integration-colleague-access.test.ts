/**
 * Integration test (real local PostgreSQL): the access My Kortix asks for a
 * colleague (projects/lib/colleague-access.ts).
 *
 * The rows pin what session create and the asks routes rely on:
 * - one open ask per list per session: asking again refreshes it, never a second card;
 * - an allow is used by exactly one start, and the colleague it created reads the list;
 * - a deny is used by no start, and the same list can be asked again;
 * - an expired ask waits on nobody and can no longer be decided;
 * - a hidden worker's ask shows on the session a person opens.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { projectSessions, sessionColleagueAccess } from '@kortix/db';
import { eq } from 'drizzle-orm';

const { db } = await import('../shared/db');
const {
  askColleagueAccess,
  colleagueAccessHash,
  consumeColleagueAccessAllow,
  decideColleagueAccessAsk,
  findColleagueAccessAllow,
  myKortixSessionGrant,
  readColleagueAccess,
} = await import('../projects/lib/colleague-access');
const { listOpenAsks, surfaceSessionIdOf } = await import('../projects/lib/session-asks');
const { seedProject } = await import('./helpers/integration-fixtures');

type SeededProject = Awaited<ReturnType<typeof seedProject>>;
let project: SeededProject;

async function seedSession(parentSessionId: string | null = null): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    status: 'running',
    agentName: 'mykortix',
    parentSessionId,
  });
  return sessionId;
}

const ACCESS = { connectors: ['gmail'], secrets: ['STRIPE_KEY'] };
const HASH = colleagueAccessHash(ACCESS);
/** The person who decides: `decided_by` keeps their id. */
const PERSON = crypto.randomUUID();

async function ask(sessionId: string, now?: Date) {
  return askColleagueAccess({
    accountId: project.account_id,
    projectId: project.project_id,
    sessionId,
    surfaceSessionId: await surfaceSessionIdOf(sessionId),
    title: 'Invoice check',
    access: ACCESS,
    accessHash: HASH,
    ...(now ? { now } : {}),
  });
}

/** Use an allow the way session create does: in a transaction, for a colleague row. */
async function useAllow(allowId: string): Promise<{ used: boolean; colleagueId: string }> {
  const colleagueId = await seedSession();
  const used = await db.transaction((tx) => consumeColleagueAccessAllow(tx, { id: allowId, colleagueSessionId: colleagueId }));
  return { used, colleagueId };
}

beforeAll(async () => {
  project = await seedProject('colleague-access');
});

describe('asking', () => {
  test('one open ask per list: asking again returns the same ask', async () => {
    const myKortix = await seedSession();
    const first = await ask(myKortix);
    const again = await ask(myKortix);
    expect(again.id).toBe(first.id);
    const open = await listOpenAsks({ projectId: project.project_id, sessionIds: [myKortix] });
    expect(open.map((a) => [a.kind, a.id, a.access])).toEqual([
      ['access', `access:${first.id}`, { colleague: 'Invoice check', connectors: ['gmail'], secrets: ['STRIPE_KEY'] }],
    ]);
  });

  test('a hidden worker’s ask shows on the session a person opens', async () => {
    const root = await seedSession();
    const worker = await seedSession(root);
    await ask(worker);
    const onRoot = await listOpenAsks({ projectId: project.project_id, surfaceSessionId: root });
    expect(onRoot.map((a) => [a.kind, a.session_id, a.surface_session_id])).toEqual([['access', worker, root]]);
  });
});

describe('deciding and using', () => {
  test('an allow is used by exactly one start, and that colleague holds the list', async () => {
    const myKortix = await seedSession();
    const { id } = await ask(myKortix);
    expect(await findColleagueAccessAllow(myKortix, HASH)).toBeNull();
    expect(await decideColleagueAccessAsk({ id, decision: 'allow', decidedBy: PERSON })).toBe(true);
    // Decided once: a second person's decision is refused.
    expect(await decideColleagueAccessAsk({ id, decision: 'deny', decidedBy: PERSON })).toBe(false);
    expect(await listOpenAsks({ projectId: project.project_id, sessionIds: [myKortix] })).toEqual([]);

    const allowId = await findColleagueAccessAllow(myKortix, HASH);
    expect(allowId).toBe(id);
    // Another list never matches it.
    expect(await findColleagueAccessAllow(myKortix, colleagueAccessHash({ connectors: ['gmail', 'notion'], secrets: ['STRIPE_KEY'] }))).toBeNull();

    const first = await useAllow(allowId!);
    const second = await useAllow(allowId!);
    expect([first.used, second.used]).toEqual([true, false]);
    expect(await findColleagueAccessAllow(myKortix, HASH)).toBeNull();

    expect(await readColleagueAccess(first.colleagueId)).toEqual(ACCESS);
    expect(await readColleagueAccess(second.colleagueId)).toBeNull();
    expect(await readColleagueAccess(myKortix)).toBeNull();
    // My Kortix holds every connector and secret its person can use; a colleague inherits it.
    expect(await myKortixSessionGrant(first.colleagueId)).toEqual({ agent: 'mykortix', permissions: 'all', connectors: 'all', env: 'all' });
    expect(await myKortixSessionGrant(myKortix)).toEqual({ agent: 'mykortix', permissions: 'all', connectors: 'all', env: 'all' });
  });

  test('a deny is used by no start, and the same list can be asked again', async () => {
    const myKortix = await seedSession();
    const { id } = await ask(myKortix);
    expect(await decideColleagueAccessAsk({ id, decision: 'deny', decidedBy: PERSON })).toBe(true);
    expect(await findColleagueAccessAllow(myKortix, HASH)).toBeNull();
    const again = await ask(myKortix);
    expect(again.id).not.toBe(id);
  });

  test('an expired ask waits on nobody, cannot be decided, and opens again when asked', async () => {
    const myKortix = await seedSession();
    const { id } = await ask(myKortix, new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect(await listOpenAsks({ projectId: project.project_id, sessionIds: [myKortix] })).toEqual([]);
    expect(await decideColleagueAccessAsk({ id, decision: 'allow', decidedBy: PERSON })).toBe(false);

    const reopened = await ask(myKortix);
    expect(reopened.id).toBe(id);
    const [row] = await db.select({ expiresAt: sessionColleagueAccess.expiresAt }).from(sessionColleagueAccess).where(eq(sessionColleagueAccess.id, id));
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await decideColleagueAccessAsk({ id, decision: 'allow', decidedBy: PERSON })).toBe(true);
  });
});
