import { EnterprisePage } from '@/features/marketing/enterprise/enterprise-page';

import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata } = marketingMetadataLayout('/enterprise');

export { generateMetadata };

/** `/enterprise`: SSO, directory sync, roles, approvals, audit and deployment for a whole company. */
export default function Page() {
  return <EnterprisePage />;
}
