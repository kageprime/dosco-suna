import { WORKSPACE_SETTINGS_SECTIONS } from '@kortix/shared/workspace-settings';
import { describe, expect, test } from 'bun:test';

import en from '../../../../translations/en.json';
import { workspaceSettingsSectionLabelKey, workspaceSettingsTabTitle } from './workspace-settings-title';

const labels = en.workspaces.settings.sections as Record<string, string>;

describe('workspaceSettingsTabTitle', () => {
  test('section, then Workspace settings, then the workspace name', () => {
    expect(workspaceSettingsTabTitle({ section: 'Members', settings: 'Workspace settings', workspace: 'Synthetic Co' })).toBe(
      'Members · Workspace settings · Synthetic Co',
    );
  });

  test('a name that did not load is left out, not guessed', () => {
    expect(workspaceSettingsTabTitle({ section: 'Git', settings: 'Workspace settings', workspace: null })).toBe(
      'Git · Workspace settings',
    );
    expect(workspaceSettingsTabTitle({ settings: 'Workspace settings', workspace: '  ' })).toBe('Workspace settings');
  });

  test('the admin template carries the section placeholder in first place', () => {
    expect(workspaceSettingsTabTitle({ section: '%s', settings: 'Workspace settings', workspace: 'Synthetic Co' })).toBe(
      '%s · Workspace settings · Synthetic Co',
    );
  });
});

describe('workspaceSettingsSectionLabelKey', () => {
  test('every section names a rail label, so its tab title is the rail word', () => {
    for (const section of WORKSPACE_SETTINGS_SECTIONS) {
      const key = workspaceSettingsSectionLabelKey(section);
      expect(key && labels[key]).toBeTruthy();
    }
  });

  test('the three renamed pages use the rail word', () => {
    expect(labels[workspaceSettingsSectionLabelKey('git')!]).toBe('Git');
    expect(labels[workspaceSettingsSectionLabelKey('repo')!]).toBe('Repository');
    expect(labels[workspaceSettingsSectionLabelKey('sandbox')!]).toBe('Sandbox');
  });

  test('a legacy alias resolves; an unknown segment names nothing', () => {
    expect(workspaceSettingsSectionLabelKey('danger-zone')).toBe('dangerZone');
    expect(workspaceSettingsSectionLabelKey('not-a-section')).toBeNull();
  });
});
