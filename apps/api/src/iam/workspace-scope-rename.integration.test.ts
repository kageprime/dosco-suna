/**
 * Workspaces R2a-2 (design.md §4 step 7): R2b step 11 renames the stored
 * action strings to their `workspace.*` names. It renames the catalog row
 * (`UPDATE kortix.permissions SET action = <workspace name>`), and the
 * `ON UPDATE CASCADE` foreign key renames every `role_permissions` row with
 * it, system roles included. This file runs that rename BEFORE the engine
 * loads its catalog and system roles (a file of its own: both are memoized
 * per process), then asserts the R2a engine still grants what each role held.
 *
 * Real PostgreSQL (its own migrated database, db-suites lane). Synthetic rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { authorize } from './authorize';
import { actorForUser } from './actor';
import { loadPermissionCatalog, loadSystemRoles } from './catalog';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
/** Held by the project manager role, not by the member tier. */
const RENAMED = { legacy: 'project.trigger.create', workspace: 'workspace.trigger.create' };

beforeAll(async () => {
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT}, 'rename-test')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url, split_pending)
    VALUES (${PROJECT}, ${ACCOUNT}, 'rename-test', 'https://example.com/r.git', false)`);
  for (const user of [MANAGER, MEMBER]) {
    await db.execute(sql`INSERT INTO kortix.account_memberships (account_id, user_id) VALUES (${ACCOUNT}, ${user})`);
    await db.execute(sql`
      INSERT INTO kortix.role_assignments (account_id, principal_type, principal_id, role_id, scope_type, scope_id, source)
      SELECT ${ACCOUNT}, 'user', ${user}, role_id, 'workspace', ${PROJECT}, 'system'
        FROM kortix.roles WHERE account_id IS NULL AND key = 'member' AND scope_type = 'account'`);
  }
  await db.execute(sql`
    INSERT INTO kortix.role_assignments (account_id, principal_type, principal_id, role_id, scope_type, scope_id, source)
    SELECT ${ACCOUNT}, 'user', ${MANAGER}, role_id, 'workspace', ${PROJECT}, 'system'
      FROM kortix.roles WHERE account_id IS NULL AND key = 'manager' AND scope_type = 'project'`);
  // R2b step 11, for one action: the catalog row is renamed and the FK cascades.
  await db.execute(sql`UPDATE kortix.permissions SET action = ${RENAMED.workspace} WHERE action = ${RENAMED.legacy}`);
});

afterAll(async () => {
  await db.execute(sql`UPDATE kortix.permissions SET action = ${RENAMED.legacy} WHERE action = ${RENAMED.workspace}`);
  await db.execute(sql`DELETE FROM kortix.projects WHERE account_id = ${ACCOUNT}`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT}`);
});

describe('after the R2b rename of a stored action string', () => {
  test('the rename reached the system role rows (the fixture is real)', async () => {
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kortix.role_permissions rp JOIN kortix.roles r USING (role_id)
       WHERE r.account_id IS NULL AND r.key = 'manager' AND rp.action = ${RENAMED.workspace}`);
    expect(row?.n).toBe(1);
  });

  test('the catalog and the system roles read the legacy name', async () => {
    const catalog = await loadPermissionCatalog();
    expect(catalog.byAction.has(RENAMED.legacy)).toBe(true);
    expect(catalog.byAction.has(RENAMED.workspace)).toBe(false);
    const roles = await loadSystemRoles();
    expect(roles.byKey.get('project:manager')?.actions.has(RENAMED.legacy)).toBe(true);
  });

  test('a manager still holds the renamed action, by either name; a member does not', async () => {
    const ws = { type: 'workspace' as const, id: PROJECT };
    for (const action of [RENAMED.legacy, RENAMED.workspace]) {
      expect((await authorize(actorForUser(MANAGER, ACCOUNT), action, ws)).allowed).toBe(true);
      expect((await authorize(actorForUser(MEMBER, ACCOUNT), action, ws)).allowed).toBe(false);
    }
    expect((await authorize(actorForUser(MEMBER, ACCOUNT), 'project.read', ws)).allowed).toBe(true);
  });
});
