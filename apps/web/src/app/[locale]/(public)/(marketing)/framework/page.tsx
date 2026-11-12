import { FrameworkPage } from '@/features/marketing/framework/framework-page';

import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata } = marketingMetadataLayout('/framework');

export { generateMetadata };

/** `/framework` ("Company as code"): Kortix as a backend framework for agents. */
export default function Page() {
  return <FrameworkPage />;
}
