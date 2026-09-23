import { redirect } from 'next/navigation';

import { marketplaceHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * `/projects/[id]/customize/marketplace` — retired, and kept only to forward.
 *
 * Marketplace moved out from Customize to its own top-level project route
 * (`/projects/[id]/marketplace`, with its own sidebar entry). This route
 * exists so that every bookmark, every catalog link, and every legacy nav id
 * taken while it lived under Customize still lands on the surface it named.
 *
 * A server redirect rather than client navigation: the target needs no
 * per-project data first, and doing it on the server means the browser never
 * paints the `(capabilities)` shell twice. Same arrangement as the retired
 * `/channels` route.
 */
export default async function RetiredProjectCustomizeMarketplaceRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(marketplaceHref(id));
}
