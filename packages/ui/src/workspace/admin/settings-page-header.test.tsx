import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CapabilityPageShell } from '../../customize/shared/capability-page-shell';
import { SettingsTabHeader } from '../../customize/settings/settings-tab-header';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import {
  SETTINGS_PAGE_TITLE_CLASS,
  SettingsPageHeader,
  SettingsPageTitleProvider,
} from '../../primitives/settings-section-header';

// Settings audit, finding 19: one page header in Workspace settings. Every
// section's h1 is the rail row's label, on one type rung, whatever header the
// pane draws (a library shell, a settings tab, a project pane).

function inSettings(label: string, node: ReactNode): string {
  return renderToStaticMarkup(<SettingsPageTitleProvider value={label}>{node}</SettingsPageTitleProvider>);
}

/** Every h1 in the markup: its class and its text. */
function h1s(html: string): Array<{ className: string; text: string }> {
  return [...html.matchAll(/<h1 class="([^"]*)">([^<]*)<\/h1>/g)].map((m) => ({ className: m[1]!, text: m[2]! }));
}

describe('Workspace settings page header', () => {
  const pages: Array<[label: string, node: ReactNode]> = [
    // Pane titles that used to differ from the rail word.
    ['Sandbox', <SettingsTabHeader key="sandbox" tab="sandbox" />],
    ['Git', <SettingsPageHeader key="git" title="Git repo" />],
    ['General', <SettingsTabHeader key="general" tab="general" />],
    ['Feature flags', <SettingsTabHeader key="flags" tab="feature-flags" />],
    // A pane with no rail entry of its own still gets its title.
    ['Danger zone', <SettingsTabHeader key="danger" tab="danger-zone" />],
    [
      'Triggers',
      <CapabilityPageShell key="triggers" title="Triggers" description="Start agents on a schedule.">
        <div />
      </CapabilityPageShell>,
    ],
    [
      'Secrets',
      <CapabilityPageShell key="secrets" title="Secrets" description="Values agents read." wide>
        <div />
      </CapabilityPageShell>,
    ],
  ];

  for (const [label, node] of pages) {
    test(`${label}: one h1, the rail word, the settings rung`, () => {
      const found = h1s(inSettings(label, node));
      expect(found).toEqual([{ className: SETTINGS_PAGE_TITLE_CLASS, text: label }]);
    });
  }

  test('outside Workspace settings each pane keeps its own title and tag', () => {
    expect(renderToStaticMarkup(<SettingsTabHeader tab="sandbox" />)).toContain('</h2>');
    expect(renderToStaticMarkup(<SettingsTabHeader tab="danger-zone" />)).toBe('');
    expect(h1s(renderToStaticMarkup(<SettingsPageHeader title="Git repo" />))[0]?.text).toBe('Git repo');
  });

  test('the Repository toolbar drops its title under the settings h1, keeps it as the page title elsewhere', () => {
    expect(h1s(inSettings('Repository', <ProjectPageHeader title="Repo" />))).toEqual([]);
    expect(inSettings('Repository', <ProjectPageHeader title="Repo" />)).not.toContain('>Repo<');
    expect(h1s(renderToStaticMarkup(<ProjectPageHeader title="Repo" />))[0]?.text).toBe('Repo');
  });
});
