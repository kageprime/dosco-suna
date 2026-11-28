import { PROJECT_ACTIONS as LIVE_PROJECT_ACTIONS, WORKSPACE_ACTION_BY_LEGACY } from '../../../iam-actions';
import type { ReviewVerdict } from './review';
import { type ReviewItem, reviewItemTarget } from './review-items';

/**
 * The project leaf actions the IAM engine answers about, one string per
 * permission a project route asserts. Ask `useCan` / `useCans` for the leaf the
 * route you are about to call asserts, never for a role name.
 *
 * Derived from the live catalog, with deprecated Rooms leaves retained for
 * published consumers until the next major.
 */
// Keep the published insertion order: deprecated Rooms precede Artifacts.
const {
  PROJECT_ARTIFACT_READ,
  PROJECT_ARTIFACT_WRITE,
  PROJECT_ARTIFACT_MANAGE,
  PROJECT_ARTIFACT_PUBLIC,
  PROJECT_CREDENTIALS_ISSUE,
  ...PROJECT_ACTIONS_BEFORE_ROOMS
} = LIVE_PROJECT_ACTIONS;

export const PROJECT_ACTIONS = {
  ...PROJECT_ACTIONS_BEFORE_ROOMS,
  /**
   * List rooms and read their messages (`agent_rooms` flag).
   *
   * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
   */
  PROJECT_ROOM_READ: 'project.room.read',
  /**
   * Create a room, post, put a session in or take it out, set the topic.
   *
   * @deprecated Rooms were removed (2026-11); the API no longer serves these routes. Removed in the next major.
   */
  PROJECT_ROOM_WRITE: 'project.room.write',
  PROJECT_ARTIFACT_READ,
  PROJECT_ARTIFACT_WRITE,
  PROJECT_ARTIFACT_MANAGE,
  PROJECT_ARTIFACT_PUBLIC,
  PROJECT_CREDENTIALS_ISSUE,
} as const;

/**
 * The workspace name of every IAM action (Workspaces: one scope, PR #11857).
 * `project.session.start` is `workspace.session.start`, `billing.read` is
 * `workspace.billing.read`, `project.create` is `workspace.create`. The rename
 * is 1:1, so a verdict for one name is the verdict for the other.
 *
 * The API accepts both names on every input, forever, and answers with both
 * (`action` plus `workspace_action`). Ask `useCan` / `useCans` with either.
 *
 * Re-exported from the lightweight canonical catalog.
 */
export { WORKSPACE_ACTION_BY_LEGACY } from '../../../iam-actions';

/** A legacy IAM action name, e.g. `'project.read'`. */
export type LegacyIamAction = keyof typeof WORKSPACE_ACTION_BY_LEGACY;
/** The workspace name of one IAM action, e.g. `'workspace.read'`. */
export type WorkspaceAction = (typeof WORKSPACE_ACTION_BY_LEGACY)[LegacyIamAction];

const LEGACY_BY_WORKSPACE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(WORKSPACE_ACTION_BY_LEGACY).map(([legacy, workspace]) => [workspace, legacy])),
);

/**
 * The workspace name of `action` (`'project.read'` → `'workspace.read'`). A
 * workspace name, a retired name or an unknown string is returned unchanged.
 */
export function toWorkspaceAction(action: string): string {
  return Object.hasOwn(WORKSPACE_ACTION_BY_LEGACY, action)
    ? WORKSPACE_ACTION_BY_LEGACY[action as LegacyIamAction]
    : action;
}

/**
 * The legacy name of `action` (`'workspace.read'` → `'project.read'`). A
 * legacy name, a retired name or an unknown string is returned unchanged.
 */
export function toLegacyAction(action: string): string {
  return Object.hasOwn(LEGACY_BY_WORKSPACE, action) ? LEGACY_BY_WORKSPACE[action]! : action;
}

/** One project leaf action, e.g. `'project.trigger.fire'`. */
export type ProjectAction = (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS];

/**
 * The leaves the trigger routes (`apps/api/src/projects/routes/triggers.ts`)
 * assert, for one `useCans` probe: create (New trigger), fire (Run now),
 * update (edit, Pause, Resume) and delete. Create, update and delete load the
 * project for write first, so `project.write` is asked too. Fire loads it for
 * read only.
 */
export const TRIGGER_CONTROL_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
] as const;

/** Which trigger controls a viewer gets. */
export interface TriggerControls {
  canCreate: boolean;
  canFire: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * The trigger controls from a `useCans` result over `TRIGGER_CONTROL_ACTIONS`.
 * A control shows only on an explicit allow, so a probe that is still loading
 * or failed shows nothing.
 */
export function triggerControlsFrom(
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): TriggerControls {
  const allowed = (action: ProjectAction) => cans[action]?.allowed === true;
  const write = allowed(PROJECT_ACTIONS.PROJECT_WRITE);
  return {
    canCreate: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE),
    canFire: allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE),
    canUpdate: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE),
    canDelete: write && allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE),
  };
}

/**
 * The leaves the change request and review routes assert, for one `useCans`
 * probe (`change-requests.ts`, `change-request-actions.ts`, `review-items.ts`
 * in `apps/api/src/projects/routes`). Each of those routes loads the project
 * for write first, so `project.write` is asked too.
 */
export const REVIEW_CONTROL_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
  PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
] as const;

/** Which change request controls a viewer gets. */
export interface ChangeRequestControls {
  /** Open a change request (`POST /change-requests`): write + gitops.push. */
  canOpen: boolean;
  /** Merge one (`/merge`): write + gitops.merge. */
  canMerge: boolean;
  /** Close or reopen one (`/close`, `/reopen`): write. */
  canClose: boolean;
}

/**
 * The change request controls from a `useCans` result over
 * `REVIEW_CONTROL_ACTIONS`. A control shows only on an explicit allow, so a
 * probe that is still loading or failed shows nothing.
 */
export function changeRequestControlsFrom(
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): ChangeRequestControls {
  const allowed = (action: ProjectAction) => cans[action]?.allowed === true;
  const write = allowed(PROJECT_ACTIONS.PROJECT_WRITE);
  return {
    canOpen: write && allowed(PROJECT_ACTIONS.PROJECT_GITOPS_PUSH),
    canMerge: write && allowed(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE),
    canClose: write,
  };
}

/**
 * Whether to offer `verdict` on `item` to a viewer whose `useCans` probe over
 * `REVIEW_CONTROL_ACTIONS` answered `cans`. The verdict routes to the flow
 * `reviewItemTarget` names:
 *
 * - Change request: approve merges it (`canMerge`). Changes, dismiss and reject
 *   (close) need project.write + project.review.act: close asserts write only,
 *   and it shows with review.act as the other verdicts do. No answer.
 * - Connector call: approve or reject only. The API lets a project manager or
 *   the person who launched the session decide, and says so per call:
 *   `canResolve` (and `previewAuthorized`) is false for anyone it would refuse.
 * - Native item: project.write + project.review.act, for every verdict.
 */
export function reviewVerdictAllowed(
  item: ReviewItem,
  verdict: ReviewVerdict,
  cans: Partial<Record<string, { allowed: boolean } | undefined>>,
): boolean {
  const target = reviewItemTarget(item.id);
  if (target.type === 'connector_call') {
    const call = item.kind === 'approval' ? item.detail.actions?.[0] : undefined;
    return (
      (verdict === 'approve' || verdict === 'reject') &&
      call?.canResolve !== false &&
      call?.previewAuthorized !== false
    );
  }
  if (target.type === 'change_request') {
    if (verdict === 'answer') return false;
    if (verdict === 'approve') return changeRequestControlsFrom(cans).canMerge;
  }
  return (
    cans[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true &&
    cans[PROJECT_ACTIONS.PROJECT_REVIEW_ACT]?.allowed === true
  );
}
