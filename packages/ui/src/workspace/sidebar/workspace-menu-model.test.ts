import { describe, expect, test } from 'bun:test';

import { workspaceMenuGroups } from './workspace-menu-model';

const ALL = { canInvite: true, canOpenSettings: true, canLeave: true };
const NONE = { canInvite: false, canOpenSettings: false, canLeave: false };

describe('workspaceMenuGroups — the workspace menu, top to bottom', () => {
  test('an owner: the workspace, then the person, then Help and Log out', () => {
    expect(workspaceMenuGroups(ALL)).toEqual([
      ['switch', 'settings', 'invite'],
      ['inbox', 'preferences', 'apps'],
      ['help', 'logout'],
    ]);
  });

  test('a member: no Invite, no Workspace settings', () => {
    expect(workspaceMenuGroups(NONE)).toEqual([['switch'], ['inbox', 'preferences', 'apps'], ['help', 'logout']]);
  });

  test('Leave shows only to a person who cannot open Workspace settings (its Danger zone)', () => {
    expect(workspaceMenuGroups(ALL).flat()).not.toContain('leave');
    expect(workspaceMenuGroups({ ...NONE, canLeave: true })[0]).toEqual(['switch', 'leave']);
  });

  test('Log out is always last', () => {
    for (const gates of [ALL, NONE]) expect(workspaceMenuGroups(gates).flat().at(-1)).toBe('logout');
  });

  test('rows with a better home stay out of the menu', () => {
    const rows = workspaceMenuGroups(ALL).flat() as string[];
    for (const gone of ['header', 'more', 'appearance', 'download']) expect(rows).not.toContain(gone);
  });
});
