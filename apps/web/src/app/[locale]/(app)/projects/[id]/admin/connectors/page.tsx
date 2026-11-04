'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** /projects/[id]/admin/connectors — redirects to unified settings connectors tab. */
export default function ProjectAdminConnectorsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) {
      router.replace(`/projects/${id}/settings?tab=connectors&category=capabilities`);
    }
  }, [id, router]);

  return null;
}
