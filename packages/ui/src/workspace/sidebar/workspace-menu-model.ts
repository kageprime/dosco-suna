/**
 * The rows of the workspace menu (the sidebar's workspace name, Slack's
 * "Acme ▾"), in order, by group:
 *
 *  1. the workspace: Switch workspace (the list, with the pending-invitation
 *     count; Create workspace sits at the bottom of that list) · Workspace
 *     settings · Invite people · Leave (only for a person who cannot open
 *     Workspace settings);
 *  2. the person: Inbox (notifications from every workspace, KRTX-1742) ·
 *     Preferences (Mod+,) · Apps and extensions (Chrome, the desktop app,
 *     your computer, MCP);
 *  3. Help (docs, support, legal) · Log out.
 *
 * Flat: one hover deep at most (Switch workspace, Help), never two. No
 * header: the trigger directly above already shows the workspace. Rows that
 * have a better home are not here — Appearance is in Preferences, and
 * Download app is a dismissible row at the foot of the sidebar (and inside
 * Apps and extensions). Leave lives in Workspace settings › Danger zone, which
 * needs `project.settings.write`; a person without that gets Leave here, or
 * they could not leave at all. Each gated row
 * follows the gate its target applies, so a row never opens a page that
 * refuses the caller.
 */
export type WorkspaceMenuRow =
  | 'switch'
  | 'settings'
  | 'invite'
  | 'leave'
  | 'inbox'
  | 'preferences'
  | 'apps'
  | 'help'
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

/** The menu's groups, top to bottom; a separator sits between two groups. */
export function workspaceMenuGroups(gates: WorkspaceMenuGates): WorkspaceMenuRow[][] {
  return [
    [
      'switch',
      ...(gates.canOpenSettings ? (['settings'] as const) : []),
      ...(gates.canInvite ? (['invite'] as const) : []),
      ...(gates.canLeave && !gates.canOpenSettings ? (['leave'] as const) : []),
    ],
    [...(gates.hasInbox ? (['inbox'] as const) : []), 'preferences', 'apps'],
    ['help', 'logout'],
  ];
}
