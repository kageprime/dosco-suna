// A Space tab (`/space/<groupId>`) reads the Space's own name and icon, the
// way the sidebar row does (KRTX-5034): from the cached space list, with
// Spaces while it loads and Unavailable once it loaded without that Space.
import type { ProjectSessionGroup } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../translations/en.json';
import { TabLabel } from './desktop-tab-strip';
import { tabRoute } from './tab-route';

const P = 'synthetic-project';
const space = (group_id: string, name: string, emoji: string): ProjectSessionGroup => ({
  group_id,
  name,
  icon: { emoji },
  position: 0,
  created_by: null,
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
});

function Tab({ path }: { path: string }) {
  const t = useTranslations('desktopTabs');
  return <TabLabel route={tabRoute(path, P)} projectId={P} pinned={false} preview={false} t={t} />;
}

function render(path: string, groups?: ProjectSessionGroup[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  client.setQueryData(qk.project.summary(P), { project_id: P, experimental: { session_groups: true } });
  if (groups) client.setQueryData(qk.project.sessionGroups(P), groups);
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <QueryClientProvider client={client}>
        <Tab path={path} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  client.clear();
  return html;
}

const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('Space tab label', () => {
  test('names the Space and draws its icon, decoding the group id', () => {
    const html = render(`/workspaces/${P}/space/g%201`, [
      space('g1', 'Other space', '🧪'),
      space('g 1', 'Launch plan', '🚀'),
    ]);
    expect(text(html)).toBe('🚀Launch plan');
  });

  test('reads Spaces while the space list loads', () => {
    expect(text(render(`/workspaces/${P}/space/g%201`))).toBe('Spaces');
  });

  test('reads Unavailable once the list loaded without the Space', () => {
    expect(text(render(`/workspaces/${P}/space/g%201`, []))).toBe('Unavailable');
  });
});
