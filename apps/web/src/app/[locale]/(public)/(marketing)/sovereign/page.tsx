import { SovereignPage } from '@/features/marketing/sovereign/sovereign-page';

import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata } = marketingMetadataLayout('/sovereign');

export { generateMetadata };

/** `/sovereign`: open source, your infrastructure, any model, files you own. */
export default function Page() {
  return <SovereignPage />;
}
