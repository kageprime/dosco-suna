'use client';

import { redirect, useParams } from 'next/navigation';

export default function ProjectMarketplacePage() {
  const { id: projectId } = useParams<{ id: string }>();
  redirect(`/workspaces/${projectId}/marketplace`);
}
