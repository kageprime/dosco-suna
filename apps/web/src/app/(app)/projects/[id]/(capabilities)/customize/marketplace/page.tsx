'use client';

import { useParams } from 'next/navigation';

import { MarketplaceView } from '@/features/marketplace/marketplace-view';

/**
 * /projects/[id]/customize/marketplace — the Marketplace capability tab.
 * Same in-project `MarketplaceView` as the legacy top-level
 * `/projects/[id]/marketplace` route, mounted at the URL the capability bar
 * builds (`capabilityTabHref(projectId, 'marketplace')`).
 */
export default function ProjectCustomizeMarketplacePage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MarketplaceView projectId={projectId} />
    </div>
  );
}
