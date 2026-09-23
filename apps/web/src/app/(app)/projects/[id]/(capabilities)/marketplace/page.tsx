import { redirect } from 'next/navigation';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * `/projects/[id]/marketplace` — kept only to forward.
 *
 * Marketplace lives under Customize (`/projects/[id]/customize/marketplace`,
 * with its own sidebar entry). This route exists so that every bookmark and
 * link taken while it briefly lived at the top level still lands on the
 * surface it named. Same arrangement as the retired `/channels` route.
 *
 * A server redirect: the target needs no per-project data first, and doing
 * it on the server means the browser never paints the `(capabilities)` shell
 * twice.
 */
export default async function RetiredProjectMarketplaceRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(capabilityTabHref(id, 'marketplace'));
}
