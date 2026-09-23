'use client';

import { useParams } from 'next/navigation';

import { MarketplaceView } from '@/features/marketplace/marketplace-view';

/**
 * /projects/[id]/marketplace — the standalone Marketplace page, reached from
 * its own top-level sidebar entry. Renders the in-project `MarketplaceView`:
 * the same explore surface the public `/marketplace` page uses, scoped to
 * this project.
 */
export default function ProjectMarketplacePage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MarketplaceView projectId={projectId} />
    </div>
  );
}
