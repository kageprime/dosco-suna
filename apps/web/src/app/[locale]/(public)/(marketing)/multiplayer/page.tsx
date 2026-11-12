import { MultiplayerPage } from '@/features/marketing/multiplayer/multiplayer-page';

import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata } = marketingMetadataLayout('/multiplayer');

export { generateMetadata };

/** `/multiplayer`: one AI for the whole team. */
export default function Page() {
  return <MultiplayerPage />;
}
