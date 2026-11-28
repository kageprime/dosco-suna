// Single source of truth for IAM permission strings.
//
// Convention: <resource>.<verb>[.subresource]. Every action is account- or
// project-scoped: `kortix.permissions.resource_type` accepts only those two.
//
// Secrets / env-vars are intentionally absent — handled separately later.
//
// WORKSPACE NAMES. Every action below also has one `workspace.*` name
// (`@kortix/shared/workspace-actions`, the one alias map). The constants here
// keep the LEGACY spelling because that is what `kortix.permissions` and
// `kortix.role_permissions` store and what old pods check. Inputs accept both
// names (`toLegacyAction` before any comparison); outputs carry the workspace
// name next to the legacy one (`toWorkspaceAction`).

import { PROJECT_ACTIONS } from '@kortix/sdk/iam-actions';
export { PROJECT_ACTIONS } from '@kortix/sdk/iam-actions';

import { toLegacyAction, toWorkspaceAction } from '@kortix/shared/workspace-actions';

export {
  isLegacyAction,
  isWorkspaceAction,
  LEGACY_ACTION_BY_WORKSPACE,
  toLegacyAction,
  toWorkspaceAction,
  WORKSPACE_ACTION_BY_LEGACY,
} from '@kortix/shared/workspace-actions';

export const RESOURCE_TYPES = ['account', 'project'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ─── Account-scoped actions ────────────────────────────────────────────────
// Always granted via a policy with scope_type='account' (the Everything scope).

export const ACCOUNT_ACTIONS = {
  ACCOUNT_READ: 'account.read',
  ACCOUNT_WRITE: 'account.write',
  ACCOUNT_DELETE: 'account.delete',

  BILLING_READ: 'billing.read',
  BILLING_WRITE: 'billing.write',

  AUDIT_READ: 'audit.read',

  MEMBER_READ: 'member.read',
  MEMBER_INVITE: 'member.invite',
  MEMBER_UPDATE: 'member.update',
  MEMBER_REMOVE: 'member.remove',
  MEMBER_SUPER_ADMIN_GRANT: 'member.super_admin.grant',

  GROUP_READ: 'group.read',
  GROUP_CREATE: 'group.create',
  GROUP_UPDATE: 'group.update',
  GROUP_DELETE: 'group.delete',
  GROUP_MEMBERS_MANAGE: 'group.members.manage',

  POLICY_READ: 'policy.read',
  POLICY_CREATE: 'policy.create',
  POLICY_DELETE: 'policy.delete',

  ROLE_READ: 'role.read',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',

  TOKEN_READ: 'token.read',
  TOKEN_CREATE: 'token.create',
  TOKEN_REVOKE: 'token.revoke',
  // A person's OWN personal access tokens. A PAT acts as the person who minted
  // it, so these grant nothing beyond that person's own roles; every system
  // account role holds them. `token.create` / `token.revoke` stay admin leaves
  // for OAuth clients, service accounts, and other people's tokens.
  TOKEN_PERSONAL_CREATE: 'token.personal.create',
  TOKEN_PERSONAL_REVOKE: 'token.personal.revoke',

  // "Create a brand-new project" must live at account scope (the project
  // doesn't exist yet to scope to).
  PROJECT_CREATE: 'project.create',

  // Dosco Capture. Every member records and reads their own capture; these
  // reach other people's. Owner and admin hold both by default.
  CAPTURE_READ_ALL: 'capture.read_all',
  CAPTURE_MANAGE: 'capture.manage',
} as const;

// ─── Project-scoped actions ────────────────────────────────────────────────
// Can be granted at scope_type='project' (a specific project) OR at
// scope_type='account' (every project in the account).

// Trigger-scoped actions (trigger.read/update/delete/fire) were removed for
// the same reason as the channel ones below: no route asserts them and the
// catalog table never held them. Triggers use the project.trigger.* leaves.

// Channel-scoped actions (channel.read/connect/send/disconnect) were removed
// (dead-catalog cleanup, IAM enforcement audit): they were cataloged with
// resource_type='channel' but never wired to assertProjectCapability (which
// only ever asserts project-scoped actions), so granting or omitting them in
// a custom role was a silent no-op. The two routes that needed a real
// send-primitive gate (Slack file upload, meet/speak) were moved onto
// project.connector.write instead — see routes/channel-slack.ts.

// ─── Aggregate type for all valid action strings ───────────────────────────

const ALL_ACTIONS = {
  ...ACCOUNT_ACTIONS,
  ...PROJECT_ACTIONS,
} as const;

export type Action = (typeof ALL_ACTIONS)[keyof typeof ALL_ACTIONS];

// Set of every valid action string. Used to validate custom-role action
// lists at the API boundary — unknown strings are rejected so a typo can't
// create a role that grants nothing useful.
export const VALID_ACTIONS: ReadonlySet<string> = new Set([
  ...Object.values(ACCOUNT_ACTIONS),
  ...Object.values(PROJECT_ACTIONS),
]);

/** A real action under EITHER name (`project.read` or `workspace.read`). */
export function isKnownAction(action: string): boolean {
  return VALID_ACTIONS.has(toLegacyAction(action));
}

/**
 * Catalog grouped for the UI's action picker. Each item carries a human
 * label so the frontend doesn't have to title-case dotted strings.
 */
export interface ActionCatalogEntry {
  /** The stored (legacy) name, e.g. `project.read`. */
  action: string;
  /** The same action's workspace name, e.g. `workspace.read`. */
  workspaceAction: string;
  label: string;
  resourceType: ResourceType;
}

function label(action: string): string {
  return action
    .split('.')
    .map((part) => part[0]?.toUpperCase() + part.slice(1).replace(/_/g, ' '))
    .join(' · ');
}

export const ACTION_CATALOG: ActionCatalogEntry[] = [
  ...Object.values(ACCOUNT_ACTIONS).map((a) => ({
    action: a,
    workspaceAction: toWorkspaceAction(a),
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
  ...Object.values(PROJECT_ACTIONS).map((a) => ({
    action: a,
    workspaceAction: toWorkspaceAction(a),
    label: label(a),
    resourceType: resourceTypeForAction(a),
  })),
];

/**
 * Returns the resource_type the engine should match against for a given
 * action. Derived from the dotted prefix.
 *
 * project.session.stop   → 'project'
 * member.invite          → 'account'  (account-level member admin)
 */
export function resourceTypeForAction(rawAction: string): ResourceType {
  // A workspace name classifies exactly as its legacy name: the rename is 1:1.
  const action = toLegacyAction(rawAction);
  const prefix = action.split('.', 1)[0] as ResourceType;
  // Member / group / role / policy / token / billing / audit / account_*
  // are all account-scoped admin actions.
  if (
    prefix === 'account' ||
    action.startsWith('member.') ||
    action.startsWith('group.') ||
    action.startsWith('role.') ||
    action.startsWith('policy.') ||
    action.startsWith('token.') ||
    action.startsWith('billing.') ||
    action.startsWith('audit.') ||
    action.startsWith('capture.') ||
    action === 'project.create'
  ) {
    return 'account';
  }
  // Otherwise the prefix is itself a resource type.
  if ((RESOURCE_TYPES as readonly string[]).includes(prefix)) {
    return prefix;
  }
  // Defensive fallback — unknown action always requires account scope.
  return 'account';
}
