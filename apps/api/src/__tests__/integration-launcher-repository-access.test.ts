/**
 * Integration test (real local DB): the launcher half of a session's
 * `repository_access` (projects/lib/launcher-repository-access.ts).
 *
 * A session reaches the repository only when its launcher holds
 * `project.file.read`. The create route already checked the request's own
 * MFA level, so this is a question about the person's role. Asked with no
 * level, the account-MFA gate refused every member of an MFA account except
 * the super admin: their sessions booted with `repository_access: false`, and
 * `kortix workspaces clone` ran `git clone ''` (prod, 2026-11-12).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, projectMembers } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { actorForUser } from '../iam/actor';
import { authorize } from '../iam/authorize';
import { launcherMayReadRepository } from '../projects/lib/launcher-repository-access';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

/** Account admin: an implicit project manager. */
const ADMIN = crypto.randomUUID();
/** Project manager by project role. */
const MANAGER = crypto.randomUUID();
/** Account member with no project role: cannot read the project. */
const OUTSIDER = crypto.randomUUID();

let mfa: SeededProject;

beforeAll(async () => {
  mfa = await seedProject('launcher-repository-access-mfa');
  await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, mfa.account_id));
  await insertIntoView(db, accountMembers, [
    { userId: ADMIN, accountId: mfa.account_id, accountRole: 'admin', isSuperAdmin: false },
    { userId: MANAGER, accountId: mfa.account_id, accountRole: 'member', isSuperAdmin: false },
    { userId: OUTSIDER, accountId: mfa.account_id, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: mfa.account_id, projectId: mfa.project_id, userId: MANAGER, projectRole: 'manager' },
  ]);
});

afterAll(async () => {
  await removeSeeded([mfa]);
});

describe('launcherMayReadRepository in an account that requires MFA', () => {
  test('the account-MFA gate still refuses a tokenless actor with no level', async () => {
    const verdict = await authorize(actorForUser(ADMIN, mfa.account_id), 'project.file.read', {
      type: 'project',
      id: mfa.project_id,
    });
    expect(verdict).toMatchObject({ allowed: false, reason: 'account_mfa_required' });
  });

  test('an account admin who is not the super admin may launch with repository access', async () => {
    expect(await launcherMayReadRepository(ADMIN, mfa.account_id, mfa.project_id)).toBe(true);
  });

  test('a project manager may launch with repository access', async () => {
    expect(await launcherMayReadRepository(MANAGER, mfa.account_id, mfa.project_id)).toBe(true);
  });

  test('a member with no project role still may not', async () => {
    expect(await launcherMayReadRepository(OUTSIDER, mfa.account_id, mfa.project_id)).toBe(false);
  });
});
