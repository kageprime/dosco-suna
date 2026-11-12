/**
 * `kortix.workspaces_reconcile_account` keeps a workspace row in place
 * (Release 2a prerequisite, design.md §4 step 4). Release 2a adds foreign keys
 * into `kortix.workspaces`; a reconcile that deletes and re-inserts a row on
 * every change would then cascade into (or be refused by) every row that
 * references it. A canary table references each project row with
 * `ON DELETE CASCADE`: a canary that disappears is a row the reconcile
 * deleted. Every value is synthetic.
 *
 * Runs against `TEST_DATABASE_URL` (its own migrated database per file); see
 * `.agents/skills/testing/SKILL.md` "DB suites".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountDeletionRequests, accounts, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../shared/db';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

// Fixed uuids, in this order: ONE < LEGACY < EMPTY < NEW. A move reconciles
// the lower account id first, so a move from LEGACY to EMPTY reconciles the
// source first and the move back reconciles the target first.
const ONE_ACCOUNT = '00000000-0000-4000-a000-00000000e101';
const LEGACY_ACCOUNT = '00000000-0000-4000-a000-00000000e102';
const EMPTY_ACCOUNT = '00000000-0000-4000-a000-00000000e103';
const NEW_ACCOUNT = '00000000-0000-4000-a000-00000000e104';
const ONE_PROJECT = '00000000-0000-4000-a000-00000000e201';
const LEGACY_P1 = '00000000-0000-4000-a000-00000000e202';
const LEGACY_P2 = '00000000-0000-4000-a000-00000000e203';
const ARCHIVED_PROJECT = '00000000-0000-4000-a000-00000000e204';
const OWNER = '00000000-0000-4000-a000-00000000e301';
const ACCOUNTS = [ONE_ACCOUNT, LEGACY_ACCOUNT, EMPTY_ACCOUNT, NEW_ACCOUNT];
const PROJECT_ROWS = [ONE_PROJECT, LEGACY_P1, LEGACY_P2, ARCHIVED_PROJECT];

const project = (projectId: string, accountId: string, name: string, extra: Partial<typeof projects.$inferInsert> = {}) => ({
  projectId, accountId, name, repoUrl: `https://example.invalid/${projectId}.git`, ...extra,
});

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM public.ws_reconcile_canary`);
  await db.delete(accountDeletionRequests).where(inArray(accountDeletionRequests.accountId, ACCOUNTS));
  await db.delete(accounts).where(inArray(accounts.accountId, ACCOUNTS));
}

async function seed(): Promise<void> {
  await cleanup();
  await db.insert(accounts).values([
    { accountId: ONE_ACCOUNT, name: 'Synthetic one' },
    { accountId: LEGACY_ACCOUNT, name: 'Synthetic legacy' },
    { accountId: EMPTY_ACCOUNT, name: 'Synthetic empty' },
    { accountId: NEW_ACCOUNT, name: 'Synthetic new' },
  ]);
  await db.insert(projects).values([
    project(ONE_PROJECT, ONE_ACCOUNT, 'Synthetic one'),
    project(ARCHIVED_PROJECT, ONE_ACCOUNT, 'Synthetic archived', { status: 'archived' }),
    project(LEGACY_P1, LEGACY_ACCOUNT, 'Synthetic legacy 1', { splitPending: true }),
    project(LEGACY_P2, LEGACY_ACCOUNT, 'Synthetic legacy 2', { splitPending: true }),
  ]);
  // One canary per project row (live or tombstone).
  await db.execute(sql`INSERT INTO public.ws_reconcile_canary (workspace_id)
    SELECT jsonb_array_elements_text(${JSON.stringify(PROJECT_ROWS)}::jsonb)::uuid`);
}

/** Project rows whose canary is gone: rows the reconcile deleted. */
async function lostRows(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM jsonb_array_elements_text(${JSON.stringify(PROJECT_ROWS)}::jsonb) AS t(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.ws_reconcile_canary c WHERE c.workspace_id = t.id::uuid)
     ORDER BY id`);
  return rows.map((row) => row.id);
}

async function row(workspaceId: string) {
  const [found] = await db.execute<{ lifecycle: string; account: string | null; former: string | null; split: boolean; name: string; mfa: boolean }>(sql`
    SELECT lifecycle, legacy_account_id::text AS account, former_account_id::text AS former,
           split_pending AS split, name, mfa_required AS mfa
      FROM kortix.workspaces WHERE workspace_id = ${workspaceId}::uuid`);
  return found ?? null;
}

/** I9 for the seeded accounts: table rows that differ from workspaces_expected. */
async function i9Seeded(): Promise<number> {
  const [found] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT a.id FROM (SELECT jsonb_array_elements_text(${JSON.stringify(ACCOUNTS)}::jsonb)::uuid AS id) a
       WHERE EXISTS (
         (SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e
          EXCEPT SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id)
         UNION ALL
         (SELECT to_jsonb(w) - 'synced_at' FROM kortix.workspaces w WHERE w.legacy_account_id = a.id OR w.former_account_id = a.id
          EXCEPT SELECT to_jsonb(e) - 'synced_at' FROM kortix.workspaces_expected(a.id) e))) x`);
  return found?.n ?? -1;
}

const moveProject = (projectId: string, toAccountId: string) =>
  db.update(projects).set({ accountId: toAccountId, updatedAt: new Date() }).where(eq(projects.projectId, projectId));

withDb('workspaces reconcile keeps rows in place', () => {
  beforeAll(async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS public.ws_reconcile_canary (
      workspace_id uuid PRIMARY KEY REFERENCES kortix.workspaces (workspace_id) ON DELETE CASCADE)`);
  });
  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DROP TABLE IF EXISTS public.ws_reconcile_canary`);
  });
  beforeEach(seed);
  afterEach(cleanup);

  test('a rename, an open and a settings write update the live row in place', async () => {
    await db.update(projects).set({ name: 'Synthetic one renamed' }).where(eq(projects.projectId, ONE_PROJECT));
    await db.update(projects).set({ lastOpenedAt: new Date() }).where(eq(projects.projectId, ONE_PROJECT));
    await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, ONE_ACCOUNT));
    expect(await lostRows()).toEqual([]);
    expect(await row(ONE_PROJECT)).toMatchObject({ lifecycle: 'active', name: 'Synthetic one renamed', mfa: true });
    expect(await i9Seeded()).toBe(0);
  });

  test('a deletion request, archiving the project while it is open, and the cancel keep the row', async () => {
    const [request] = await db.insert(accountDeletionRequests)
      .values({ accountId: ONE_ACCOUNT, userId: OWNER, scheduledFor: new Date(Date.now() + 86_400_000).toISOString() })
      .returning({ id: accountDeletionRequests.id });
    expect((await row(ONE_PROJECT))?.lifecycle).toBe('closing');
    await db.update(projects).set({ status: 'archived', updatedAt: new Date() }).where(eq(projects.projectId, ONE_PROJECT));
    expect((await row(ONE_PROJECT))?.lifecycle).toBe('closing');
    await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, ONE_PROJECT));
    await db.update(accountDeletionRequests).set({ status: 'cancelled' }).where(eq(accountDeletionRequests.id, request!.id));
    expect(await lostRows()).toEqual([]);
    expect((await row(ONE_PROJECT))?.lifecycle).toBe('active');
    expect(await i9Seeded()).toBe(0);
  });

  test('archiving one of two legacy projects turns it into a tombstone in place; the other becomes the one live row', async () => {
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, LEGACY_P2));
    expect(await lostRows()).toEqual([]);
    expect(await row(LEGACY_P2)).toMatchObject({ lifecycle: 'tombstone', account: null, former: LEGACY_ACCOUNT });
    expect(await row(LEGACY_P1)).toMatchObject({ lifecycle: 'active', account: LEGACY_ACCOUNT, split: false });
    // And back: both live and split_pending again, the same two rows.
    await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, LEGACY_P2));
    expect(await lostRows()).toEqual([]);
    expect([(await row(LEGACY_P1))?.split, (await row(LEGACY_P2))?.split]).toEqual([true, true]);
    expect(await i9Seeded()).toBe(0);
  });

  test('a project that moves to another account keeps its row, whichever account is reconciled first', async () => {
    // Source first (LEGACY < EMPTY): the split's shape, a legacy project into a fresh account.
    await moveProject(LEGACY_P2, EMPTY_ACCOUNT);
    expect(await lostRows()).toEqual([]);
    expect(await row(LEGACY_P2)).toMatchObject({ lifecycle: 'active', account: EMPTY_ACCOUNT, split: false });
    expect(await row(LEGACY_P1)).toMatchObject({ lifecycle: 'active', account: LEGACY_ACCOUNT, split: false });
    // EMPTY's project-less row gave way to the project.
    expect(await row(EMPTY_ACCOUNT)).toBeNull();
    // Target first (the reverse): back into the legacy account. Like the
    // split's reverse, both projects are flagged first, so the 1:1 index
    // never sees two unflagged projects in one account.
    await db.update(projects).set({ splitPending: true }).where(inArray(projects.projectId, [LEGACY_P1, LEGACY_P2]));
    await moveProject(LEGACY_P2, LEGACY_ACCOUNT);
    expect(await lostRows()).toEqual([]);
    expect(await row(LEGACY_P2)).toMatchObject({ account: LEGACY_ACCOUNT, split: true });
    expect(await row(EMPTY_ACCOUNT)).toMatchObject({ lifecycle: 'dormant', account: EMPTY_ACCOUNT });
    // A 1:1 project out of an account that keeps an archived one: the source
    // turns dormant, its tombstone stays a tombstone.
    await moveProject(ONE_PROJECT, NEW_ACCOUNT);
    expect(await lostRows()).toEqual([]);
    expect(await row(ONE_PROJECT)).toMatchObject({ lifecycle: 'active', account: NEW_ACCOUNT });
    expect(await row(ONE_ACCOUNT)).toMatchObject({ lifecycle: 'dormant', account: ONE_ACCOUNT });
    expect(await row(ARCHIVED_PROJECT)).toMatchObject({ lifecycle: 'tombstone', former: ONE_ACCOUNT });
    expect(await i9Seeded()).toBe(0);
  });

  test('a deleted project row and a deleted account remove their own rows only', async () => {
    await db.delete(projects).where(eq(projects.projectId, LEGACY_P2));
    expect(await lostRows()).toEqual([LEGACY_P2]);
    // The split_pending flag of the survivor is the split's plan pass to clear.
    expect(await row(LEGACY_P1)).toMatchObject({ lifecycle: 'active', account: LEGACY_ACCOUNT });
    await db.delete(accounts).where(eq(accounts.accountId, ONE_ACCOUNT));
    expect(await lostRows()).toEqual([ONE_PROJECT, ARCHIVED_PROJECT, LEGACY_P2].sort());
    expect(await i9Seeded()).toBe(0);
  });
});
