import { MarketplaceView } from '@/features/marketplace/marketplace-view';

export default async function WorkspaceMarketplacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MarketplaceView projectId={id} />;
}
