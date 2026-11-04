'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * /projects/[id]/admin — Redirects to the single Unified Settings Page (/projects/[id]/settings).
 */
export default function ProjectAdminPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) {
      router.replace(`/projects/${id}/settings`);
    }
  }, [id, router]);

  return null;
}
