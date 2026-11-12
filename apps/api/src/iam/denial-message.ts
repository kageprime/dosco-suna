// What a 403 SAYS. Pure — no DB, no request, no Hono context beyond the
// HTTPException it builds — and deliberately its own module rather than part of
// `authorize.ts`: several route tests replace the engine wholesale with
// `mock.module`, so every name a non-test module imports from it is a name those
// stubs must also declare. The wording policy has no reason to live behind that.

import { HTTPException } from 'hono/http-exception';
import { toWorkspaceAction } from '@kortix/shared/workspace-actions';
import { markAccountMfaDenial, markAgentGrantDenial } from '../shared/dead-credential-log';

const MFA_DENIAL_MESSAGE =
  'This workspace requires multi-factor authentication. Verify your second factor and retry.';

/**
 * The agent-principal refusal family: every reason whose constraint is a
 * STABLE property of the caller (its kortix_permissions grant, its ceiling,
 * its service-account role) and whose remedy the typed body already names.
 * Their warn lines share the log throttle — see shared/dead-credential-log.ts
 * (KRTX-4635). Deliberately outside: `sso_required` (one redirect fixes it),
 * whose constraint clears in-session, and the generic fallbacks, whose cause
 * is unknown here. `account_mfa_required` joined the throttle separately
 * (KRTX-4674): its constraint clears only through the step-up dialog, so a
 * caller that polls instead of stepping up receives the same refusal forever.
 */
const AGENT_GRANT_DENIAL_REASONS = new Set([
  'agent_scope_insufficient',
  'agent_ceiling_insufficient',
  'agent_grant_escalation',
  'agent_human_only_action',
  'service_account_scope_insufficient',
]);

/**
 * The message for a denial whose REASON — not the action — names what the
 * caller has to change. Returns null when the reason carries no
 * caller-actionable meaning, so the caller keeps its own action-shaped wording.
 *
 * This exists because a denial's reason is the only thing that can distinguish
 * WHICH constraint fired. `authorizeV2` folds three independent limits into one
 * boolean — the human's project role, the agent session's `kortix_permissions` grant,
 * and an activated service account's assigned role — and a caller that
 * re-derives the cause from a second `authorize()` probe cannot separate them.
 * Guessing "your role is too low" at an account owner whose AGENT grant denied
 * the call sends them to a remedy that can never work.
 *
 * Naming the constraint class is not a policy oracle. The caller already holds
 * the credential whose own scope produced the denial, and the action is the one
 * it just requested — neither discloses anything about the account's wider
 * permission model, who else holds what, or which other actions would succeed.
 */
export function denialReasonMessage(rawAction: string, reason?: string): string | null {
  // Outputs lead with the workspace name of the action (design.md §3.2 C8);
  // an agent copies what it reads into kortix.yaml.
  const action = toWorkspaceAction(rawAction);
  switch (reason) {
    case 'account_mfa_required':
      return MFA_DENIAL_MESSAGE;
    case 'agent_scope_insufficient':
      // The agent-session token's own grant denied it, at any role. Mirrors the
      // wording assertAgentScope already uses for the same constraint.
      return `This agent session is not granted "${action}". Add it to the agent's kortix_permissions in kortix.yaml and merge the change.`;
    case 'agent_ceiling_insufficient':
      // Agent-principal model: the manifest lists the action, the role an admin
      // bound to the agent's service account does not. Editing kortix.yaml
      // cannot fix this.
      return `This agent's role does not allow "${action}". Ask a workspace admin to raise the role bound to this agent.`;
    case 'agent_human_only_action':
      return `"${action}" mints a credential or moves money, so the person does it themselves: API keys in Settings → API keys, payments in Billing. Hand them that link; no kortix_permissions entry or role changes this.`;
    case 'service_account_scope_insufficient':
      // The session authorizes AS the agent's service account (an admin gave it
      // a standing role), so the launching user's role is irrelevant here.
      return `This agent runs as its own service account, and the role assigned to it does not allow "${action}". Ask a workspace admin to update that role.`;
    case 'sso_required':
      // The account enforces single sign-on for this email domain. The remedy
      // is a new sign-in through the IdP, not a role change.
      return 'Your organization requires single sign-on. Sign in with your company SSO to continue.';
    case 'key_scope_insufficient':
      // The key's own scope (read, or a custom list) denied it. The creator's
      // role is not the limit, so a role change cannot fix it.
      return `This key's scope does not include "${action}". Mint a key with that permission, or use a full key.`;
    case 'token_out_of_scope':
      return 'This key is bound to one workspace and cannot be used for this request.';
    case 'token_account_shared':
      // The token's own workspace, but its legacy account still holds other
      // workspaces: the account rows are theirs too. No grant or flag lifts it.
      return `"${action}" reads or changes account-wide data that this workspace still shares with other workspaces of the same legacy account, so a workspace key or session token cannot use it. Use a personal key: run \`kortix login\` on your own machine, or open the web app.`;
    case 'workspace_closed':
      return 'This workspace is being deleted. Only its owners can open it, to restore it.';
    case 'resource_scope_insufficient':
      return 'You are not granted access to this resource.';
    default:
      return null;
  }
}

/**
 * Turn a denial into the HTTPException the route layer surfaces. Exported for
 * unit tests.
 *
 * Reason-specific wording comes from `denialReasonMessage`; everything else
 * falls back to a plain humanized message for the action. `account_mfa_required`
 * additionally carries a machine-readable `code` because the web client keys
 * its step-up dialog on it (the SDK's ApiError already lifts `code` from error
 * bodies).
 */
/** Denials where the person's role (not an agent grant) lacks the action. */
const ROLE_REASONS: ReadonlySet<string> = new Set(['project_role_insufficient', 'account_role_insufficient']);

export function buildDenialError(
  action: string,
  reason?: string,
  messageOverride?: string,
  opts: { workspaceName?: string | null } = {},
): HTTPException {
  const workspaceAction = toWorkspaceAction(action);
  if (reason === 'account_mfa_required') {
    const mfaErr = new HTTPException(403, {
      message: MFA_DENIAL_MESSAGE,
      res: jsonResponse({ error: MFA_DENIAL_MESSAGE, code: 'account_mfa_required', action, workspace_action: workspaceAction }),
    });
    // An account-policy refusal a polling caller can receive forever, so its
    // LINE joins the log throttle (KRTX-4674). The response is untouched.
    markAccountMfaDenial(mfaErr);
    return mfaErr;
  }
  const base =
    messageOverride ??
    denialReasonMessage(action, reason) ??
    // The person's role is the side that lacks it, whether they call directly
    // or through an agent session that acts for them: say who grants it.
    (ROLE_REASONS.has(reason ?? '')
      ? `${humanizePermissionDenial(action).replace(/\.$/, '')}. A workspace owner or admin grants "${workspaceAction}" in Settings → People.`
      : humanizePermissionDenial(action));
  // A caller who belongs to the workspace already knows its name; the route
  // passes it only then, never on a no-access denial (no existence probe).
  const message = opts.workspaceName ? `${base.replace(/\.$/, '')} in "${opts.workspaceName}".` : base;
  // Every 403 from
  // `authorize` names its verdict reason (`code`) and the `action`. The body
  // keeps the global error handler's `{error, message, status}` shape and adds
  // the two fields, so a client that reads `message` is unchanged. The CLI
  // picks its remedy hint from `code` (apps/cli/src/token-denial.ts).
  const err = new HTTPException(403, {
    message,
    res: jsonResponse({
      error: true,
      message,
      status: 403,
      code: reason ?? 'forbidden',
      // `action` stays the legacy name for old clients; `workspace_action` is the name to show.
      action,
      workspace_action: workspaceAction,
    }),
  });
  // A stable agent-principal denial is the one 4xx a caller can receive
  // forever, so its LINE joins the log throttle (KRTX-4635). The response is
  // untouched — the body keeps carrying code, action and the remedy.
  if (reason && AGENT_GRANT_DENIAL_REASONS.has(reason)) markAgentGrantDenial(err);
  return err;
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } });
}

/**
 * Map action codes (`project.create`, `member.invite`, …) to a sentence
 * the user can act on. Unknown codes get a generic phrase with the code
 * suffixed for support visibility. Keep this list short — only the
 * actions that actually show up in user-visible 403s.
 */
function humanizePermissionDenial(action: string): string {
  const verb = ACTION_VERBS[action];
  if (verb) return `You don't have permission to ${verb}.`;
  // Generic fallback. Suffix the code so support can still identify
  // which gate fired without needing server logs.
  return `You don't have permission to perform this action (${toWorkspaceAction(action)}).`;
}

const ACTION_VERBS: Record<string, string> = {
  // Projects
  'project.create': 'create workspaces',
  'project.write': 'change this workspace',
  'project.delete': 'delete this workspace',
  // Workspace members
  'project.members.manage': 'manage workspace members',
  // Account
  'account.write': 'change workspace settings',
  'account.delete': 'delete this workspace',
  // Members
  'member.invite': 'invite members',
  'member.remove': 'remove members',
  'member.update': 'change member roles',
  'member.read': 'view members',
  'member.super_admin.grant': 'grant super-admin',
  'member.super_admin.revoke': 'revoke super-admin',
  // Groups
  'group.create': 'create groups',
  'group.update': 'change groups',
  'group.delete': 'delete groups',
  'group.read': 'view groups',
  'group.members.manage': 'manage group members',
  // Audit
  'audit.read': 'view the audit log',
  'audit.export': 'export audit events',
  // Tokens
  'token.read': 'view API keys',
  'token.create': 'create workspace keys',
  'token.revoke': 'revoke workspace keys',
  'token.personal.create': 'create your own personal key',
  'token.personal.revoke': 'revoke your own personal key',
  'capture.read_all': 'read other members’ Kortix Capture recordings',
  'capture.manage': 'manage Kortix Capture for this workspace',
  // Billing
  'billing.read': 'view billing',
  'billing.write': 'change billing',
};
