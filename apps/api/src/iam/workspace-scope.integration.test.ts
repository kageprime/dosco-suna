/**
 * Workspaces R2a-2 (design.md §4 step 7): the engine reads the WORKSPACE form
 * of a grant exactly as it reads the legacy form.
 *
 * Release 2b rewrites `kortix.role_assignments` to one scope
 * (`scope_type = 'workspace'`, `scope_id = <workspace id>`) and the stored
 * action strings to their `workspace.*` names (step 11). R2a and R2b pods run
 * side by side, so the R2a engine must already read that form. This suite
 * writes the SAME grants twice, into two 1:1 workspaces: once in today's form
 * (`account` / `project`, legacy action names) and once in the workspace form
 * (`workspace`, `workspace.*` action names), and asserts that every verdict
 * and every read model answers the same for both.
 *
 * Real PostgreSQL (the db-suites lane gives this file its own migrated
 * database). Every row it reads is seeded here, with synthetic values.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { authorize, type Obj } from './authorize';
import { actorForUser } from './actor';
import {
  accountRoleFor,
  countAccountOwners,
  customRoleBindings,
  groupProjectGrants,
  objectGrantRows,
  projectRoleForUser,
} from './read-models';

type Form = 'legacy' | 'workspace';
const FORMS: Form[] = ['legacy', 'workspace'];
const uid = () => crypto.randomUUID();

/** Kinds of principal, one user of each kind per form. */
const KINDS = ['owner', 'admin', 'member', 'manager', 'groupManager', 'customAccount', 'customProject', 'objectUser'] as const;
type Kind = (typeof KINDS)[number];

interface Seeded {
  accountId: string;
  projectId: string;
  users: Record<Kind, string>;
}
const seeded = {} as Record<Form, Seeded>;
/** A second, unrelated 1:1 workspace (the reach test). */
const OTHER = { accountId: uid(), projectId: uid() };
const CROSS_USER = uid();

const AGENT = 'outreach-bot';
/** The custom roles grant one account action and one project action the member tier lacks. */
const CUSTOM_ACCOUNT_ACTIONS = ['audit.read', 'project.trigger.create'];
const CUSTOM_PROJECT_ACTIONS = ['project.trigger.create'];
const WORKSPACE_NAME: Record<string, string> = {
  'audit.read': 'workspace.audit.read',
  'project.trigger.create': 'workspace.trigger.create',
};

async function systemRoleId(key: string, scopeType: 'account' | 'project'): Promise<string> {
  const [row] = await db.execute<{ role_id: string }>(
    sql`SELECT role_id::text FROM kortix.roles WHERE account_id IS NULL AND key = ${key} AND scope_type = ${scopeType}`,
  );
  if (!row) throw new Error(`system role ${scopeType}:${key} is not seeded`);
  return row.role_id;
}

async function seedWorkspace(accountId: string, projectId: string, name: string) {
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${accountId}, ${name})`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url, split_pending)
    VALUES (${projectId}, ${accountId}, ${name}, 'https://example.com/ws.git', false)`);
}

async function addMembership(accountId: string, userId: string) {
  await db.execute(sql`INSERT INTO kortix.account_memberships (account_id, user_id) VALUES (${accountId}, ${userId}) ON CONFLICT DO NOTHING`);
}

/**
 * One assignment in the form under test. `scope` is the LEGACY scope; the
 * workspace form writes `scope_type = 'workspace'` and `scope_id = projectId`
 * for both, exactly what R2b step 11 writes.
 */
async function assign(
  form: Form,
  input: {
    accountId: string;
    projectId: string;
    principalType: 'user' | 'group';
    principalId: string;
    roleId: string;
    scope: 'account' | 'project';
    object?: { type: string; id: string };
  },
) {
  const scopeType = form === 'workspace' ? 'workspace' : input.scope;
  const scopeId = form === 'workspace' || input.scope === 'project' ? input.projectId : null;
  await db.execute(sql`
    INSERT INTO kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id, object_type, object_id, source)
    VALUES (${input.accountId}, ${input.principalType}, ${input.principalId}, ${input.roleId}, ${scopeType},
            ${scopeId}::uuid, ${input.object?.type ?? null}, ${input.object?.id ?? null}, 'system')`);
}

/** A custom role of the account; the workspace form stores the `workspace.*` names. */
async function customRole(form: Form, accountId: string, scopeType: 'account' | 'project', actions: string[]): Promise<string> {
  const [row] = await db.execute<{ role_id: string }>(sql`
    INSERT INTO kortix.roles (account_id, key, name, scope_type)
    VALUES (${accountId}, ${`dept-${scopeType}-${uid().slice(0, 8)}`}, 'Department', ${scopeType})
    RETURNING role_id::text`);
  for (const action of actions) {
    const stored = form === 'workspace' ? WORKSPACE_NAME[action]! : action;
    await db.execute(sql`INSERT INTO kortix.role_permissions (role_id, action) VALUES (${row!.role_id}::uuid, ${stored})`);
  }
  return row!.role_id;
}

async function seedForm(form: Form): Promise<Seeded> {
  const accountId = uid();
  const projectId = uid();
  await seedWorkspace(accountId, projectId, `scope-${form}`);
  const users = Object.fromEntries(KINDS.map((kind) => [kind, uid()])) as Record<Kind, string>;
  const base = { accountId, projectId } as const;
  const roles = {
    owner: await systemRoleId('owner', 'account'),
    admin: await systemRoleId('admin', 'account'),
    accountMember: await systemRoleId('member', 'account'),
    manager: await systemRoleId('manager', 'project'),
    agentUser: await systemRoleId('agent-user', 'project'),
  };
  for (const kind of KINDS) {
    await addMembership(accountId, users[kind]);
    const roleId = kind === 'owner' ? roles.owner : kind === 'admin' ? roles.admin : roles.accountMember;
    await assign(form, { ...base, principalType: 'user', principalId: users[kind], roleId, scope: 'account' });
  }
  await assign(form, { ...base, principalType: 'user', principalId: users.manager, roleId: roles.manager, scope: 'project' });

  const groupId = uid();
  await db.execute(sql`INSERT INTO kortix.account_groups (group_id, account_id, name) VALUES (${groupId}, ${accountId}, ${`eng-${form}`})`);
  await db.execute(sql`INSERT INTO kortix.account_group_members (group_id, user_id) VALUES (${groupId}, ${users.groupManager})`);
  await assign(form, { ...base, principalType: 'group', principalId: groupId, roleId: roles.manager, scope: 'project' });

  const accountCustom = await customRole(form, accountId, 'account', CUSTOM_ACCOUNT_ACTIONS);
  await assign(form, { ...base, principalType: 'user', principalId: users.customAccount, roleId: accountCustom, scope: 'account' });
  const projectCustom = await customRole(form, accountId, 'project', CUSTOM_PROJECT_ACTIONS);
  await assign(form, { ...base, principalType: 'user', principalId: users.customProject, roleId: projectCustom, scope: 'project' });

  await assign(form, {
    ...base,
    principalType: 'user',
    principalId: users.objectUser,
    roleId: roles.agentUser,
    scope: 'project',
    object: { type: 'agent', id: AGENT },
  });
  return { accountId, projectId, users };
}

/** Every check the parity matrix asks, against the form's own workspace. */
function checks(s: Seeded): Array<{ name: string; action: string; obj: Obj }> {
  const ws = { type: 'workspace' as const, id: s.projectId };
  return [
    { name: 'account member.invite', action: 'member.invite', obj: { type: 'account' } },
    { name: 'account audit.read', action: 'audit.read', obj: { type: 'account' } },
    { name: 'account billing.write', action: 'billing.write', obj: { type: 'account' } },
    { name: 'account role.create', action: 'role.create', obj: { type: 'account' } },
    { name: 'workspace read', action: 'project.read', obj: ws },
    { name: 'workspace write', action: 'project.write', obj: ws },
    { name: 'workspace session.start', action: 'project.session.start', obj: ws },
    { name: 'workspace trigger.create', action: 'project.trigger.create', obj: ws },
    { name: 'workspace members.manage', action: 'project.members.manage', obj: ws },
    { name: 'workspace delete', action: 'project.delete', obj: ws },
    { name: 'agent use', action: 'project.agent.read', obj: { ...ws, resource: { type: 'agent', id: AGENT } } },
    { name: 'workspace name trigger.create', action: 'workspace.trigger.create', obj: ws },
  ];
}

async function verdicts(s: Seeded, kind: Kind): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const check of checks(s)) {
    out[check.name] = (await authorize(actorForUser(s.users[kind], s.accountId), check.action, check.obj)).allowed;
  }
  return out;
}

beforeAll(async () => {
  // The workspace-form custom roles store `workspace.*` names; the catalog
  // holds them after R2b's rename. Add them next to the legacy rows here.
  for (const [legacy, workspace] of Object.entries(WORKSPACE_NAME)) {
    await db.execute(sql`
      INSERT INTO kortix.permissions (action, scope_type, resource_type, delegable, description, area, level, implies)
      SELECT ${workspace}, scope_type, resource_type, delegable, description, area, level, implies
        FROM kortix.permissions WHERE action = ${legacy}
      ON CONFLICT (action) DO NOTHING`);
  }
  for (const form of FORMS) seeded[form] = await seedForm(form);
  await seedWorkspace(OTHER.accountId, OTHER.projectId, 'scope-other');
});

afterAll(async () => {
  const accountIds = [seeded.legacy?.accountId, seeded.workspace?.accountId, OTHER.accountId].filter(Boolean) as string[];
  for (const accountId of accountIds) {
    await db.execute(sql`DELETE FROM kortix.projects WHERE account_id = ${accountId}`);
    await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${accountId}`);
  }
  await db.execute(sql`DELETE FROM kortix.permissions WHERE action LIKE 'workspace.%'`);
});

describe('authorize: the workspace form of a grant answers like the legacy form', () => {
  for (const kind of KINDS) {
    test(`${kind}: every verdict is identical in both forms`, async () => {
      const legacy = await verdicts(seeded.legacy, kind);
      const workspace = await verdicts(seeded.workspace, kind);
      expect(workspace).toEqual(legacy);
    });
  }

  test('the matrix is not vacuous: the workspace form grants what each role holds', async () => {
    const v = (kind: Kind) => verdicts(seeded.workspace, kind);
    const owner = await v('owner');
    expect(owner['account member.invite']).toBe(true);
    expect(owner['workspace delete']).toBe(true);
    const admin = await v('admin');
    expect(admin['account member.invite']).toBe(true);
    expect(admin['workspace members.manage']).toBe(true);
    const member = await v('member');
    expect(member['workspace read']).toBe(true);
    expect(member['workspace write']).toBe(false);
    expect(member['account member.invite']).toBe(false);
    expect(member['workspace trigger.create']).toBe(false);
    expect(member['agent use']).toBe(false);
    expect((await v('manager'))['workspace members.manage']).toBe(true);
    expect((await v('groupManager'))['workspace write']).toBe(true);
    const customAccount = await v('customAccount');
    expect(customAccount['account audit.read']).toBe(true);
    expect(customAccount['workspace trigger.create']).toBe(true);
    expect(customAccount['workspace name trigger.create']).toBe(true);
    expect(customAccount['account member.invite']).toBe(false);
    const customProject = await v('customProject');
    expect(customProject['workspace trigger.create']).toBe(true);
    expect(customProject['account audit.read']).toBe(false);
    expect((await v('objectUser'))['agent use']).toBe(true);
  });
});

describe('read models: the workspace form lists like the legacy form', () => {
  test('account roles, owner count and project roles', async () => {
    for (const form of FORMS) {
      const s = seeded[form];
      expect(await accountRoleFor(s.accountId, s.users.owner)).toBe('owner');
      expect(await accountRoleFor(s.accountId, s.users.admin)).toBe('admin');
      expect(await accountRoleFor(s.accountId, s.users.member)).toBe('member');
      expect(await countAccountOwners(s.accountId)).toBe(1);
      expect(await projectRoleForUser(s.projectId, s.users.manager)).toBe('manager');
      expect(await projectRoleForUser(s.projectId, s.users.member)).toBeNull();
    }
  });

  test('the account_members view reads the owner and admin roles', async () => {
    for (const form of FORMS) {
      const s = seeded[form];
      const rows = await db.execute<{ user_id: string; account_role: string }>(sql`
        SELECT user_id::text, account_role::text FROM kortix.account_members WHERE account_id = ${s.accountId}`);
      const byUser = new Map(rows.map((row) => [row.user_id, row.account_role]));
      expect(byUser.get(s.users.owner)).toBe('owner');
      expect(byUser.get(s.users.admin)).toBe('admin');
      expect(byUser.get(s.users.member)).toBe('member');
    }
  });

  test('group grants, custom-role bindings and object grants', async () => {
    const shape = async (s: Seeded) => ({
      groupGrants: (await groupProjectGrants({ accountId: s.accountId, projectId: s.projectId })).map((g) => g.role),
      accountBindings: (await customRoleBindings({ accountId: s.accountId, scopeType: 'account' })).map((b) => [b.scopeType, b.scopeId]),
      accountBindingsByNullScope: (await customRoleBindings({ accountId: s.accountId, scopeId: null })).length,
      projectBindings: (await customRoleBindings({ accountId: s.accountId, scopeType: 'project', scopeId: s.projectId })).map((b) => b.scopeType),
      reaching: (await customRoleBindings({ accountId: s.accountId, reachingProjectId: s.projectId })).length,
      objectGrants: (await objectGrantRows({ projectId: s.projectId })).map((g) => [g.resourceType, g.resourceId, g.projectId === s.projectId]),
    });
    const legacy = await shape(seeded.legacy);
    const workspace = await shape(seeded.workspace);
    expect(legacy).toEqual({
      groupGrants: ['manager'],
      accountBindings: [['account', null]],
      accountBindingsByNullScope: 1,
      projectBindings: ['project'],
      reaching: 2,
      objectGrants: [['agent', AGENT, true]],
    });
    // An account-scope binding reads with scope_id NULL in both forms.
    expect(workspace).toEqual(legacy);
  });
});

describe('reach: a workspace-form grant stays in its own workspace', () => {
  test('a workspace-form row naming another account’s workspace is refused at write', async () => {
    const roleId = await systemRoleId('manager', 'project');
    const refused = await assign('workspace', {
      accountId: seeded.workspace.accountId,
      projectId: OTHER.projectId,
      principalType: 'user',
      principalId: CROSS_USER,
      roleId,
      scope: 'project',
    }).then(
      () => null,
      (error: { cause?: { code?: string; message?: string } }) => error.cause,
    );
    // The guard trigger (role_assignments_project_account_guard), SQLSTATE 23503.
    expect(refused?.code).toBe('23503');
    expect(refused?.message).toMatch(/^workspace .* does not belong to account/);
  });

  test('an owner and a manager in workspace form are only members of another workspace they join', async () => {
    const s = seeded.workspace;
    await addMembership(s.accountId, CROSS_USER);
    await addMembership(OTHER.accountId, CROSS_USER);
    const ownerRole = await systemRoleId('owner', 'account');
    const memberRole = await systemRoleId('member', 'account');
    const managerRole = await systemRoleId('manager', 'project');
    await assign('workspace', { ...s, principalType: 'user', principalId: CROSS_USER, roleId: ownerRole, scope: 'account' });
    await assign('workspace', { ...s, principalType: 'user', principalId: CROSS_USER, roleId: managerRole, scope: 'project' });
    await assign('workspace', { ...OTHER, principalType: 'user', principalId: CROSS_USER, roleId: memberRole, scope: 'account' });
    const here = actorForUser(CROSS_USER, s.accountId);
    const there = actorForUser(CROSS_USER, OTHER.accountId);
    expect((await authorize(here, 'member.invite', { type: 'account' })).allowed).toBe(true);
    expect((await authorize(there, 'member.invite', { type: 'account' })).allowed).toBe(false);
    expect((await authorize(there, 'project.write', { type: 'workspace', id: OTHER.projectId })).allowed).toBe(false);
    expect((await authorize(there, 'project.read', { type: 'workspace', id: OTHER.projectId })).allowed).toBe(true);
    // The owner row of workspace A names A's account only.
    expect((await authorize(here, 'project.write', { type: 'workspace', id: OTHER.projectId })).allowed).toBe(false);
  });
});
