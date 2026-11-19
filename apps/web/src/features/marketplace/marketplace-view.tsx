'use client';

import { useTranslations } from '@/i18n/use-translations';
import { CaretLeftIcon as ChevronLeft } from '@phosphor-icons/react';
import { useMemo, useRef } from 'react';

import { Button } from '@kortix/ui/button';
import { SidebarToggle } from '@kortix/ui/internal/layout/sidebar-toggle';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { useMarketplaceItem, useMarketplaceItems, useMarketplaces } from '@/hooks/marketplace';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { MarketplaceDetail, useDetailNav } from './marketplace-detail';
import { MarketplaceExplore } from './marketplace-explore';
import { MarketplaceSurfaceProvider, type MarketplaceSurface } from './marketplace-surface';

/** Stable empty set — installing is agent-driven now (no registry-lock to
 *  read), so there's no "installed" state to track here; kept as an empty
 *  `Set` purely so `MarketplaceSurface` consumers still compile. */
const NO_INSTALLED_NAMES = new Set<string>();

/** In-project marketplace (Customize → Marketplace). Renders the exact same
 *  `MarketplaceExplore` as the public `/marketplace` page — same source rail,
 *  projects showcase, featured + sectioned skills, cards, and detail — just
 *  embedded in the panel and driven through the "project" surface (adds
 *  start an agent-import session in THIS project, in-panel overlay
 *  navigation). */
export function MarketplaceView({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);

  const browseScrollContainerRef = useRef<HTMLDivElement>(null);

  const surface = useMemo<MarketplaceSurface>(
    () => ({ variant: 'project', projectId, installedNames: NO_INSTALLED_NAMES, openItem }),
    [projectId, openItem],
  );

  return (
    <MarketplaceSurfaceProvider surface={surface}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {/* Canonical titlebar row — matches `SettingsFrame`, stays pinned while panes scroll. */}
        <div className="kx-titlebar-row kx-capability-titlebar relative flex h-11 shrink-0 items-center gap-1 border-b px-2">
          <SidebarToggle />
          {openId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeDetail}
              className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-sm font-medium"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
              {tI18nComplete.raw('textc608981d8d68')}
            </Button>
          ) : (
            <p className="text-foreground truncate px-2 text-sm font-medium">
              {tI18nComplete.raw('textc608981d8d68')}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {openId ? (
            <MarketplaceDetailOverlay onBack={closeDetail} />
          ) : (
            <MarketplaceExploreTab scrollContainerRef={browseScrollContainerRef} />
          )}
        </div>
      </div>
    </MarketplaceSurfaceProvider>
  );
}

/** Fetches the catalog client-side (no SSR in-project) and renders the shared
 *  explore, embedded + scoped to authenticated reads. */
function MarketplaceExploreTab({
  scrollContainerRef,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const marketplacesQuery = useMarketplaces({ publicOnly: false });
  const itemsQuery = useMarketplaceItems({ publicOnly: false });

  const marketplaces = marketplacesQuery.data?.marketplaces ?? [];
  const allItems = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const projectItems = useMemo(
    () => allItems.filter((i) => i.type === 'registry:project'),
    [allItems],
  );

  if (itemsQuery.isLoading || marketplacesQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <MarketplaceExplore
      items={allItems}
      marketplaces={marketplaces}
      projectItems={projectItems}
      embedded
      syncUrl={false}
      publicOnly={false}
      scrollContainerRef={scrollContainerRef}
    />
  );
}

/** Fetches the open item by id and renders the shared detail as an in-panel
 *  overlay (the project surface makes its actions install into this project). */
function MarketplaceDetailOverlay({ onBack }: { onBack: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const query = useMarketplaceItem(openId);

  // Sibling order for ← / → browsing — the same catalog list the explore grid
  // renders. Clamped at the ends.
  const itemsQuery = useMarketplaceItems({ publicOnly: false });
  const ids = useMemo(() => (itemsQuery.data?.items ?? []).map((i) => i.id), [itemsQuery.data]);
  const nav = useDetailNav(ids, openId ?? undefined, openItem);

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center">
        <Loading />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          {tI18nComplete.raw('text76900f1bfd16')}
        </Button>
        <p className="text-muted-foreground text-sm">{tI18nComplete.raw('text90b1ad72d8b7')}</p>
      </div>
    );
  }
  return <MarketplaceDetail data={query.data} onBack={onBack} nav={nav} />;
}
