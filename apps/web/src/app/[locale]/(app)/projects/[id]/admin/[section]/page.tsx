'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

function mapAdminSectionToSettingsTab(section?: string): { tab: string; category: string } {
  if (!section) return { tab: 'general', category: 'capabilities' };
  switch (section) {
    case 'repo':
    case 'git':
      return { tab: 'git', category: 'capabilities' };
    case 'snapshots':
    case 'sandbox':
      return { tab: 'sandbox', category: 'capabilities' };
    case 'experimental':
    case 'feature-flags':
      return { tab: 'feature-flags', category: 'capabilities' };
    case 'loops':
    case 'triggers':
      return { tab: 'triggers', category: 'capabilities' };
    case 'models':
      return { tab: 'models', category: 'capabilities' };
    case 'connectors':
      return { tab: 'connectors', category: 'capabilities' };
    case 'secrets':
      return { tab: 'secrets', category: 'capabilities' };
    case 'skills':
      return { tab: 'skills', category: 'capabilities' };
    case 'tools':
      return { tab: 'tools', category: 'capabilities' };
    case 'extensions':
      return { tab: 'extensions', category: 'capabilities' };
    case 'drives':
      return { tab: 'drives', category: 'capabilities' };
    case 'review':
      return { tab: 'review', category: 'capabilities' };
    case 'members':
      return { tab: 'members', category: 'capabilities' };
    case 'general':
      return { tab: 'general', category: 'capabilities' };
    default:
      return { tab: section, category: 'capabilities' };
  }
}

/** /projects/[id]/admin/<section> — Redirects to the unified settings page. */
export default function ProjectAdminSectionPage() {
  const { id, section } = useParams<{ id: string; section?: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) {
      const { tab, category } = mapAdminSectionToSettingsTab(section);
      router.replace(`/projects/${id}/settings?tab=${encodeURIComponent(tab)}&category=${category}`);
    }
  }, [id, section, router]);

  return null;
}
