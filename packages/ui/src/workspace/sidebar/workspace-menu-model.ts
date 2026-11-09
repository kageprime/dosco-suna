/**
 * The rows of the workspace menu (the sidebar's workspace name, Slack's
 * "Acme ▾"), in order, by group:
 *
 *  1. the workspace header (icon and name);
 *  2. the workspace: Invite people · Workspace settings · Switch workspace
 *     (the list, with the pending-invitation count; Create workspace sits at
 *     the bottom of that list, beside the workspaces it adds to);
 *  3. the person: Inbox (notifications from every workspace, KRTX-1742) ·
 *     Preferences (Mod+,) · More (Apps and extensions, Appearance, Help,
 *     Download app: rows a person opens rarely, one level down);
 *  4. Leave {name} · Log out.
 *
 * Seven rows at most at the top level: the rows used daily stay in reach,
 * and the rest wait one hover away. Each gated row follows the gate its
 * target applies, so a row never opens a page that refuses the caller.
 */
export type WorkspaceMenuRow =
  | 'header'
  | 'invite'
  | 'settings'
  | 'switch'
  | 'inbox'
  | 'preferences'
  | 'more'
  | 'leave'
  | 'logout';

export interface WorkspaceMenuGates {
  /** `project.members.manage`: the Members section's invite. */
  canInvite: boolean;
  /** Customize › Workspace settings' gate (`config`). */
  canOpenSettings: boolean;
  /** Not the last owner (`useLeaveWorkspace`). */
  canLeave: boolean;
  /** The host serves an Inbox page (`useInboxSummary(...).href` is set). */
  hasInbox: boolean;
}

/** The menu's groups, top to bottom; a separator sits between two non-empty groups. */
export function workspaceMenuGroups(gates: WorkspaceMenuGates): WorkspaceMenuRow[][] {
  const groups: WorkspaceMenuRow[][] = [
    ['header'],
    [
      ...(gates.canInvite ? (['invite'] as const) : []),
      ...(gates.canOpenSettings ? (['settings'] as const) : []),
      'switch',
    ],
    [...(gates.hasInbox ? (['inbox'] as const) : []), 'preferences', 'more'],
    [...(gates.canLeave ? (['leave'] as const) : []), 'logout'],
  ];
  return groups.filter((group) => group.length > 0);
}
