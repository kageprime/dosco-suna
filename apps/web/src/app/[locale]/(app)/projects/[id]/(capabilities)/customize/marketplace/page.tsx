import { redirect } from 'next/navigation';

import { marketplaceHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * `/projects/[id]/customize/marketplace` — kept only to forward.
 *
 * Marketplace left Customize for its own top-level route
 * (`/projects/[id]/marketplace`). This route exists so that every bookmark
 * and link taken while it lived under Customize still lands on the surface
 * it named. Same arrangement as the retired `/channels` route.
 *
 * A server redirect: the target needs no per-project data first, and doing
 * it on the server means the browser never paints the `(capabilities)` shell
 * twice.
 */
export default async function RetiredCustomizeMarketplaceRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(marketplaceHref(id));
}
