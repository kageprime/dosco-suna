import { normalizeChangeRequestRef } from '@kortix/shared/change-request-links';
import { notFound } from 'next/navigation';

import { ChangeRequestLink } from '@/components/projects/change-request-link';

/** Compatibility for shared REST-shaped links. Review remains the canonical page. */
export default async function ChangeRequestPage({ params }: {
  params: Promise<{ id: string; crId: string }>;
}) {
  const { id, crId } = await params;
  const ref = normalizeChangeRequestRef(crId);
  if (!ref) notFound();
  return <ChangeRequestLink workspaceId={id} crRef={ref} />;
}
