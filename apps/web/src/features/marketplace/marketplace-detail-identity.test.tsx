// Characterization tests for the marketplace detail's shared blocks: the item
// identity (avatar, title, type label, description) renders the same on both
// layouts (public page header + overlay sidebar rail), and the part-of-project
// row navigates per surface (a link on public, a button in the overlay).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MarketplaceItemDetail } from '@/lib/marketplace-client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { AuthProvider } from '@/features/providers/auth-provider';
import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceDetail } from './marketplace-detail';
import { MarketplaceSurfaceProvider } from './marketplace-surface';

const skillData: MarketplaceItemDetail = {
  id: 'synthetic:skill', registry: 'synthetic', name: 'skill', type: 'registry:skill',
  title: 'Synthetic skill', description: 'Synthetic description', categories: [],
  capabilities: { secrets: [], connectors: [], tools: [], network: [] },
  dependencies: [], dependencyItems: [], fileCount: 0, external: true,
  marketplaceId: 'synthetic', marketplaceLabel: 'Synthetic source', owner: 'synthetic',
  sourceUrl: 'https://example.test/source', files: [], readme: null,
};

function withPartOfProject(item: MarketplaceItemDetail): MarketplaceItemDetail {
  return { ...item, partOfProject: { id: 'synthetic:proj', title: 'Synthetic project' } };
}

function mount(data: MarketplaceItemDetail, opts: { surface: 'public' | 'project'; onBack?: () => void }) {
  const surface = opts.surface === 'public'
    ? { variant: 'public' as const, itemHref: marketplaceItemHref, openItem: () => {} }
    : { variant: 'project' as const, projectId: 'synthetic-project', installedNames: new Set<string>(), openItem: () => {} };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MarketplaceSurfaceProvider surface={surface}>
        <AppRouterContext.Provider value={{ bfcacheId: 'synthetic', back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch: async () => {} }}>
          <AuthProvider>
            <MarketplaceDetail data={data} onBack={opts.onBack} />
          </AuthProvider>
        </AppRouterContext.Provider>
      </MarketplaceSurfaceProvider>
    </QueryClientProvider>,
  );
}

describe('item identity on both detail layouts', () => {
  test('public page header and overlay rail show the same title, type label and description', () => {
    const publicHtml = mount(skillData, { surface: 'public' });
    const railHtml = mount(skillData, { surface: 'project', onBack: () => {} });
    for (const html of [publicHtml, railHtml]) {
      expect(html).toContain('Synthetic skill</h1>');
      // The type label: the translated singular with its icon, under the title.
      expect(html).toContain('Skill</span>');
      expect(html).toContain('Synthetic description');
    }
  });
});

describe('part-of-project row per surface', () => {
  test('a link on the public surface', () => {
    const html = mount(withPartOfProject(skillData), { surface: 'public', onBack: () => {} });
    expect(html).toContain(`<a class="group bg-popover`);
    expect(html).toContain(`href="${marketplaceItemHref('synthetic:proj')}"`);
    expect(html).toContain('>Synthetic project</span></a>');
  });

  test('a button on the project surface', () => {
    const html = mount(withPartOfProject(skillData), { surface: 'project', onBack: () => {} });
    expect(html).toContain('<button type="button" class="group bg-popover');
    expect(html).toContain('>Synthetic project</span></button>');
  });
});
