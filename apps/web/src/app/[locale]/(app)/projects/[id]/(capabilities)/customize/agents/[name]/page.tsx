'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function ProjectAgentDetailPage() {
  const { id: projectId, name } = useParams<{ id: string; name: string }>();
  const router = useRouter();

  useEffect(() => {
    if (projectId && name) {
      let agentName = name;
      try {
        agentName = decodeURIComponent(name);
      } catch {
        // Fall back to raw name
      }
      router.replace(`/projects/${projectId}/settings?tab=agents&agent=${encodeURIComponent(agentName)}`);
    }
  }, [projectId, name, router]);

  return null;
}
