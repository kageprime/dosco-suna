import { describe, expect, test } from 'bun:test';

import { workspaceMenuGroups } from './workspace-menu-model';

const ALL = { canInvite: true, canOpenSettings: true, canLeave: true, hasInbox: true };
const NONE = { canInvite: false, canOpenSettings: false, canLeave: false, hasInbox: false };

describe('workspaceMenuGroups — the workspace menu, top to bottom', () => {
  test('an owner of a shared workspace: the workspace, then the person, then Leave above Log out', () => {
    expect(workspaceMenuGroups(ALL)).toEqual([
      ['header'],
      ['invite', 'settings', 'switch'],
      ['inbox', 'preferences', 'more'],
      ['leave', 'logout'],
    ]);
  });

  test('a member: no Invite, no Workspace settings, and Leave', () => {
    expect(workspaceMenuGroups({ ...NONE, canLeave: true })).toEqual([
      ['header'],
      ['switch'],
      ['preferences', 'more'],
      ['leave', 'logout'],
    ]);
  });

  test('the last owner gets no Leave, and Log out stays last', () => {
    const rows = workspaceMenuGroups({ ...ALL, canLeave: false }).flat();
    expect(rows).not.toContain('leave');
    expect(rows.at(-1)).toBe('logout');
  });

  test('the top level stays short: rarely used rows wait under More', () => {
    const rows = workspaceMenuGroups(ALL).flat() as string[];
    expect(rows.filter((row) => row !== 'header').length).toBeLessThanOrEqual(8);
    for (const rare of ['apps', 'appearance', 'help', 'download', 'create']) expect(rows).not.toContain(rare);
  });

  test('the Inbox is a menu row above Preferences, below the workspace rows (KRTX-1742)', () => {
    const rows = workspaceMenuGroups(ALL).flat();
    expect(rows.indexOf('inbox')).toBeGreaterThan(rows.indexOf('switch'));
    expect(rows.indexOf('preferences')).toBe(rows.indexOf('inbox') + 1);
  });

  test('a host that serves no Inbox page gets no Inbox row', () => {
    expect(workspaceMenuGroups({ ...ALL, hasInbox: false }).flat()).not.toContain('inbox');
  });
});
