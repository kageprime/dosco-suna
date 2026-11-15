/**
 * Integration test (real local DB): the session list's `working=only` filter,
 * which a workspace Running view reads (dev audit finding 19).
 *
 * Running work was visible only as spinners on rows of the session tree, one
 * session at a time. The filter runs in SQL before the keyset page: a session
 * whose running box holds a live turn (`session_sandboxes.metadata.activeTurns`)
 * is listed, a parked box or an empty turn map is not. Every row is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { loadProjectSessionInventory } from '../projects/lib/session-list';
import { readSessionsWorking } from '../projects/lib/session-working-read';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const VIEWER = crypto.randomUUID();
const tag = crypto.randomUUID().slice(0, 8);
const sid = (id: string) => `${id}-${tag}`;

type Box = { status: 'active' | 'provisioning' | 'stopped'; turn: boolean } | null;

async function seed(id: string, input: { minutesAgo: number; parent?: string; name: string; box: Box }) {
  const at = new Date(Date.now() - input.minutesAgo * 60_000);
  await db.insert(projectSessions).values({
    sessionId: sid(id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: sid(id),
    createdBy: VIEWER,
    visibility: 'project',
    parentSessionId: input.parent ? sid(input.parent) : null,
    metadata: { name: input.name, ...(input.parent ? { spawned_by_session: sid(input.parent) } : {}) },
    createdAt: at,
    updatedAt: at,
  });
  if (!input.box) return;
  const token = `turn-${id}-${tag}`;
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId: sid(id),
    accountId: ACCOUNT,
    projectId: PROJECT,
    provider: 'platinum',
    status: input.box.status,
    metadata: input.box.turn
      ? { activeTurns: { [token]: { token, state: 'active', runtimeSessionId: `rt-${id}`, startedAtMs: at.getTime() } } }
      : { activeTurns: {} },
  });
}

const list = (working: boolean) =>
  loadProjectSessionInventory({
    projectId: PROJECT,
    accountId: ACCOUNT,
    userId: VIEWER,
    scope: 'visible',
    boundCredentialSessionId: null,
    probeManageCapability: async () => false,
    limit: 50,
    cursor: null,
    filter: { working },
  });

const ids = (items: { row: { sessionId: string } }[]) => items.map((item) => item.row.sessionId.replace(`-${tag}`, '')).sort();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-list-working-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
  // A parent whose turn ended, its workflow runner and one agent at work, one
  // agent done (box still up), a colleague booting, a parked box with a stale map.
  await seed('parent', { minutesAgo: 10, name: 'Plan the launch', box: { status: 'active', turn: false } });
  await seed('runner', { minutesAgo: 9, parent: 'parent', name: 'Launch research (workflow)', box: { status: 'active', turn: true } });
  await seed('agent-a', { minutesAgo: 8, parent: 'runner', name: 'Market size', box: { status: 'active', turn: true } });
  await seed('agent-b', { minutesAgo: 8, parent: 'runner', name: 'Competitors', box: { status: 'active', turn: false } });
  await seed('colleague', { minutesAgo: 7, name: 'Weekly digest', box: { status: 'provisioning', turn: true } });
  await seed('parked', { minutesAgo: 6, name: 'Old chat', box: { status: 'stopped', turn: true } });
  await seed('no-box', { minutesAgo: 5, name: 'Never started', box: null });
});

afterAll(async () => {
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades sessions
});

describe('session list working=only', () => {
  test('lists only the sessions whose running box holds a live turn: runners, agents and colleagues', async () => {
    const page = await list(true);
    expect(ids(page.items)).toEqual(['agent-a', 'colleague', 'runner']);
  });

  test('serves no idle ancestor beside a working child', async () => {
    const page = await list(true);
    expect(ids(page.items)).not.toContain('parent');
  });

  test('every listed row derives working.state "working", which the route keeps', async () => {
    const page = await list(true);
    const working = await readSessionsWorking(page.items.map((item) => item.row.sessionId));
    for (const item of page.items) expect(working.get(item.row.sessionId)?.state).toBe('working');
  });

  test('without the filter the list is unchanged', async () => {
    const page = await list(false);
    expect(ids(page.items)).toEqual(['agent-a', 'agent-b', 'colleague', 'no-box', 'parent', 'parked', 'runner']);
  });
});
