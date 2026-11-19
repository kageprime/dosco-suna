import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MarketplaceItem, MarketplaceSummary } from '@/lib/marketplace-client';
import { MarketplaceExplore } from './marketplace-explore';
import { MarketplaceSurfaceProvider } from './marketplace-surface';

const EMPTY_CAPS = { secrets: [], connectors: [], tools: [], network: [] };

const SOURCES: MarketplaceSummary[] = Array.from({ length: 10 }, (_, idx): MarketplaceSummary => {
  const types: Record<string, number> =
    idx === 0 ? { 'registry:project': 1, 'registry:skill': idx + 4 } : { 'registry:skill': idx + 5 };
  return {
    id: idx === 0 ? 'kortix' : `synthetic-source-${idx}`,
    label: idx === 0 ? 'Dosco' : `Synthetic Source ${idx}`,
    owner: 'synthetic',
    sourceUrl: 'https://example.test/source',
    count: idx + 5,
    types,
    external: idx !== 0,
  };
});

const PROJECT_ITEMS: MarketplaceItem[] = [
  {
    id: 'kortix:starter',
    registry: 'kortix',
    name: 'starter',
    type: 'registry:project',
    title: 'Synthetic Starter Workspace',
    description: 'Workspace template description',
    categories: [],
    capabilities: EMPTY_CAPS,
    dependencies: [],
    fileCount: 1,
    external: false,
    marketplaceId: 'kortix',
    marketplaceLabel: 'Dosco',
    owner: 'dosco',
    sourceUrl: 'https://example.test/starter',
  },
];

const SKILL_ITEMS: MarketplaceItem[] = [
  {
    id: 'synthetic-source-1:skill-one',
    registry: 'synthetic-source-1',
    name: 'skill-one',
    type: 'registry:skill',
    title: 'Synthetic Skill One',
    description: 'Skill description',
    categories: [],
    capabilities: EMPTY_CAPS,
    dependencies: [],
    fileCount: 1,
    external: true,
    marketplaceId: 'synthetic-source-1',
    marketplaceLabel: 'Synthetic Source 1',
    owner: 'synthetic',
    sourceUrl: 'https://example.test/skill',
  },
];

function renderExplore(embedded: boolean) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MarketplaceSurfaceProvider
        surface={
          embedded
            ? {
                variant: 'project',
                projectId: 'synthetic-project',
                installedNames: new Set<string>(),
                openItem: () => {},
              }
            : {
                variant: 'public',
                itemHref: (id) => `/marketplace/${id}`,
                openItem: () => {},
              }
        }
      >
        <MarketplaceExplore
          items={SKILL_ITEMS}
          marketplaces={SOURCES}
          projectItems={PROJECT_ITEMS}
          embedded={embedded}
          syncUrl={!embedded}
          publicOnly={!embedded}
        />
      </MarketplaceSurfaceProvider>
    </QueryClientProvider>,
  );
}

describe('workspace marketplace fixed-rail and decluttered layout', () => {
  test('route bounds viewport height and view uses canonical titlebar with SidebarToggle', () => {
    const pageSource = readFileSync(
      join(import.meta.dir, '../../app/[locale]/(app)/workspaces/[id]/marketplace/page.tsx'),
      'utf8',
    );
    expect(pageSource).toContain('h-svh');
    expect(pageSource).toContain('overflow-hidden');

    const viewSource = readFileSync(join(import.meta.dir, 'marketplace-view.tsx'), 'utf8');
    expect(viewSource).toContain('kx-titlebar-row');
    expect(viewSource).toContain('<SidebarToggle />');
  });

  test('embedded marketplace puts sources nav in aside (folded at 8) and moves hero, search, and scope tabs into main', () => {
    const html = renderExplore(true);
    const asideStart = html.indexOf('<aside');
    const asideEnd = html.indexOf('</aside>');
    const mainStart = html.indexOf('<main');
    const mainEnd = html.indexOf('</main>');
    expect(asideStart).toBeGreaterThan(-1);
    expect(mainStart).toBeGreaterThan(asideEnd);

    const asideHtml = html.slice(asideStart, asideEnd);
    const mainHtml = html.slice(mainStart, mainEnd);

    // Rail stays nav-only: sources + Show more fold, no hero h1 or search input.
    expect(asideHtml).toContain('Sources');
    expect(asideHtml).toContain('All sources');
    expect(asideHtml).toContain('Show more');
    expect(asideHtml).not.toContain('Synthetic Source 9');
    expect(asideHtml).not.toContain('<h1');
    expect(asideHtml).not.toContain('<input');

    // Main scrolling column hosts the page title, search box, scope tabs, and grids.
    expect(mainHtml).toContain('<h1');
    expect(mainHtml).toContain('<input');
    expect(mainHtml).toContain('All');
    expect(mainHtml).toContain('Workspaces');
    expect(mainHtml).toContain('Skills');
    expect(mainHtml).toContain('sm:grid-cols-3');
    expect(mainHtml).toContain('overflow-y-auto');
  });

  test('public marketplace keeps marketing layout intact', () => {
    const html = renderExplore(false);
    expect(html).toContain('lg:sticky lg:top-32');
    expect(html).toContain('sm:grid-cols-2');
    expect(html).toContain('Show more');
  });
});
