import { CompliancePage } from '@/features/marketing/compliance/compliance-page';

import { marketingMetadataLayout } from '@/lib/seo/metadata';

const { generateMetadata } = marketingMetadataLayout('/compliance');

export { generateMetadata };

/** `/compliance`: sign-in, access, approvals and audit, for IT and compliance reviewers. */
export default function Page() {
  return <CompliancePage />;
}
