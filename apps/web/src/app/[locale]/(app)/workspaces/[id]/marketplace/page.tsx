import { MarketplaceView } from '@/features/marketplace/marketplace-view';

export default async function WorkspaceMarketplacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // `h-svh` bounds the workspace marketplace pane so the titlebar and source
  // rail stay pinned while only the catalog column scrolls — same contract as
  // `ProjectAdminRoute` and `(capabilities)/layout.tsx`.
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <MarketplaceView projectId={id} />
    </div>
  );
}
