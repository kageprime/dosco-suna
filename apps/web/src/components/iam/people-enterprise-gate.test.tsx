// People panes on a workspace without Enterprise (settings audit, finding 21):
// Roles lists the built-in roles above the custom-roles upsell, and a
// member's empty Groups section says Groups is Enterprise and links to the
// Groups pane instead of asking for an action it has no control for.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemberGroupsSection } from './member-access-panel';
import { RolesTab } from './roles-tab';

const noop = () => {};

function render(node: ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  client.clear();
  return html;
}

describe('Roles pane without Enterprise', () => {
  const html = render(<RolesTab accountId="synthetic-account" canManage rbacEnabled={false} />);

  test('lists the four built-in roles, highest first, each with its summary', () => {
    const names = ['Owner', 'Admin', 'Manager', 'Member'];
    const at = names.map((name) => html.indexOf(`>${name}<`));
    for (const index of at) expect(index).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('Built-in roles');
    expect(html).toContain('Full control: billing, people, and deleting the workspace.');
    expect(html).toContain('Works in sessions with the agents they are granted.');
  });

  test('keeps the custom-roles upsell, under the list', () => {
    expect(html).toContain('Custom roles are an Enterprise feature');
    expect(html.indexOf('Built-in roles')).toBeLessThan(html.indexOf('Custom roles are an Enterprise feature'));
  });

  test('offers no write control', () => {
    expect(html).not.toContain('New role');
    expect(html).not.toContain('Duplicate');
  });
});

describe('a member with no groups', () => {
  const props = { accountId: 'synthetic-account', memberGroups: [], isLoading: false, onOpenGroup: noop };

  test('without Enterprise: says Groups is Enterprise and links to the Groups pane', () => {
    const html = render(<MemberGroupsSection {...props} rbacEnabled={false} />);
    expect(html).toContain('Groups are part of Enterprise.');
    expect(html).not.toContain('Add them to a group');
    expect(html).toMatch(/<a [^>]*>Open Groups<\/a>/);
  });

  test('with Enterprise: asks to add them to a group and links to the Groups pane', () => {
    const html = render(<MemberGroupsSection {...props} rbacEnabled />);
    expect(html).toContain('Add them to a group to inherit its access.');
    expect(html).toMatch(/<a [^>]*>Open Groups<\/a>/);
  });
});
